import { CookieJar } from "./cookie_jar.ts";
import { ByteBudget, type SlotQueue } from "./slot_queue.ts";
import type { ResidentHandle } from "./boot.ts";
import {
  GuestHttpError,
  type GuestHttpOptions,
  type GuestHttpReply,
  type GuestMethod,
  validateGuestPath,
} from "./guest_http.ts";
import { appPrefix, type GuestAppId } from "./guest_apps.ts";
import type { DatasetteSnapshot } from "./datasette_protocol.ts";

export interface GuestAppContext {
  finite(
    line: string,
    stdin?: Uint8Array,
    timeoutMs?: number,
  ): Promise<{ code: number; stdout: string; stderr: string }>;
  asset(name: string): Promise<Uint8Array>;
}
export interface GuestAppSpec {
  id: GuestAppId;
  title: string;
  dir: string;
  prepare(ctx: GuestAppContext): Promise<void>;
  reset(ctx: GuestAppContext): Promise<void>;
  spawnLine(prefix: string, port: number): string;
  readyPath(prefix: string): string;
  isReady(reply: GuestHttpReply): boolean;
}
export interface GuestAppDependencies {
  queue: SlotQueue;
  uuid(): string;
  now(): number;
  servicePort: number;
  delay(ms: number, signal?: AbortSignal): Promise<void>;
  spawn(line: string): Promise<ResidentHandle>;
  finite(
    line: string,
    stdin?: Uint8Array,
    timeoutMs?: number,
  ): Promise<{ code: number; stdout: string; stderr: string }>;
  asset(name: string, signal: AbortSignal): Promise<Uint8Array>;
  request(options: GuestHttpOptions): Promise<GuestHttpReply>;
  portBusy(): Promise<boolean>;
  changed(snapshot: DatasetteSnapshot): void;
}
export interface GuestAppRequest {
  session: string;
  requestId: string;
  method: GuestMethod;
  path: string;
  headers: [string, string][];
  body?: ArrayBuffer;
  referrer?: string;
}
const quote = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'";
const resetCancelled = new Error("reset cancelled");

export class GuestApp {
  #snapshot: DatasetteSnapshot = { state: "stopped" };
  #resident?: ResidentHandle;
  #ended = false;
  #generation = 0;
  #startup?: AbortController;
  #starting?: Promise<DatasetteSnapshot>;
  #setup: Promise<void> = Promise.resolve();
  #cleanup: Promise<unknown> = Promise.resolve();
  #jar = new CookieJar();
  #budget = new ByteBudget();
  #requests = new Map<string, AbortController>();
  constructor(
    readonly spec: GuestAppSpec,
    readonly deps: GuestAppDependencies,
  ) {}
  get snapshot(): DatasetteSnapshot {
    return { ...this.#snapshot };
  }
  #set(snapshot: DatasetteSnapshot) {
    this.#snapshot = snapshot;
    this.deps.changed(this.snapshot);
  }
  #cancelRequests() {
    this.#jar.clear();
    for (const c of this.#requests.values()) c.abort();
    this.#requests.clear();
  }
  #serialize<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.#cleanup.then(fn, fn);
    this.#cleanup = result.catch(() => {});
    return result;
  }
  start(): Promise<DatasetteSnapshot> {
    if (this.#snapshot.state === "stuck") {
      return Promise.reject(new Error("resident exit unconfirmed"));
    }
    if (this.#starting) return this.#starting;
    if (this.#snapshot.state === "running") {
      return Promise.resolve(this.snapshot);
    }
    if (this.#snapshot.state === "stopping") {
      return Promise.reject(new Error("resident is stopping"));
    }
    const generation = ++this.#generation;
    const controller = this.#startup = new AbortController();
    this.#budget = new ByteBudget();
    const session = this.deps.uuid();
    const prefix = appPrefix(this.spec.id, session);
    validateGuestPath(this.spec.id, session, prefix, prefix);
    this.#set({ state: "starting", session, prefix });
    let started = 0;
    this.#setup = (async () => {
      await this.#cleanup;
      controller.signal.throwIfAborted();
      await this.spec.prepare(this.#ctx(controller.signal));
      controller.signal.throwIfAborted();
      if (await this.deps.portBusy()) {
        throw new Error(`port ${this.deps.servicePort} is in use`);
      }
      controller.signal.throwIfAborted();
      const resident = await this.deps.spawn(
        `echo $$ > ${quote(this.spec.dir + "/server.pid")} && ${
          this.spec.spawnLine(prefix, this.deps.servicePort)
        } > ${quote(this.spec.dir + "/server.log")} 2>&1`,
      );
      this.#resident = resident;
      this.#ended = false;
      started = this.deps.now();
      void resident.exited.then(
        (code) => this.#exit(resident, code),
        (error) => this.#exit(resident, error),
      );
    })();
    const work = (async () => {
      try {
        await this.#setup;
        controller.signal.throwIfAborted();
        const pid = await this.#finite(
          `i=0; while [ ! -s ${
            quote(this.spec.dir + "/server.pid")
          } ] && [ $i -lt 5 ]; do sleep 1; i=$((i+1)); done; exec cat ${
            quote(this.spec.dir + "/server.pid")
          }`,
        );
        if (Number(pid.stdout.trim()) !== this.#resident?.pid) {
          throw new Error("resident pid file mismatch");
        }
        await this.#ready(
          session,
          prefix,
          controller.signal,
          started + 240_000,
        );
        controller.signal.throwIfAborted();
        if (generation === this.#generation && !this.#ended) {
          this.#set({ state: "running", session, prefix });
        }
      } catch (error) {
        if (generation === this.#generation) {
          controller.abort();
          this.#cancelRequests();
          const reason = error instanceof Error ? error.message : String(error);
          await this.#serialize(() => this.#stopResident());
          if (generation !== this.#generation) return this.snapshot;
          let tail: string;
          try {
            tail = (await this.#finite(
              `exec tail -c 8192 ${quote(this.spec.dir + "/server.log")}`,
              undefined,
              30_000,
            )).stdout;
          } catch (e) {
            tail = `log unavailable: ${
              e instanceof Error ? e.message : String(e)
            }`;
          }
          if (generation !== this.#generation) return this.snapshot;
          this.#set({
            state: this.#snapshot.state === "stuck" ? "stuck" : "failed",
            error: reason,
            logTail: tail,
          });
        }
      }
      return this.snapshot;
    })();
    this.#starting = work;
    void work.finally(() => {
      if (this.#starting === work) this.#starting = undefined;
    }).catch(() => {});
    return work;
  }
  stop(): Promise<DatasetteSnapshot> {
    if (this.#snapshot.state === "stuck") return Promise.resolve(this.snapshot);
    ++this.#generation;
    this.#startup?.abort();
    this.#cancelRequests();
    this.#set({ state: "stopping" });
    return this.#serialize(async () => {
      await this.#setup.catch(() => {});
      await this.#stopResident();
      return this.snapshot;
    });
  }
  reset(): Promise<DatasetteSnapshot> {
    if (this.#snapshot.state === "stuck") {
      return Promise.reject(new Error("resident exit unconfirmed"));
    }
    ++this.#generation;
    const generation = this.#generation;
    this.#startup?.abort();
    this.#cancelRequests();
    this.#set({ state: "stopping" });
    // Keep Start disabled until the sample state is restored; publishing
    // "stopped" earlier would let Start abort this reset.
    return this.#serialize(async () => {
      try {
        await this.#setup.catch(() => {});
        await this.#stopResident(false);
        if (generation !== this.#generation) return this.snapshot;
        if (this.#resident && !this.#ended) {
          throw new Error("resident exit unconfirmed");
        }
        await this.spec.reset(this.#ctx(undefined, generation));
        if (generation === this.#generation) this.#set({ state: "stopped" });
        return this.snapshot;
      } catch (error) {
        if (error === resetCancelled) return this.snapshot;
        if (
          generation === this.#generation && this.#snapshot.state !== "stuck"
        ) {
          this.#set({
            state: "failed",
            error: error instanceof Error ? error.message : String(error),
          });
        }
        throw error;
      }
    });
  }
  async #finite(line: string, stdin?: Uint8Array, timeoutMs?: number) {
    const result = await this.deps.finite(line, stdin, timeoutMs);
    if (result.code !== 0) {
      throw new Error(
        `guest command failed (${result.code}): ${result.stderr}`,
      );
    }
    return result;
  }
  #exit(resident: ResidentHandle, detail: unknown) {
    if (this.#resident !== resident) return;
    this.#ended = true;
    this.#startup?.abort(new Error(`resident exited: ${String(detail)}`));
    this.#cancelRequests();
    if (this.#snapshot.state === "stuck") this.#set({ state: "stopped" });
    else if (this.#snapshot.state === "running") {
      this.#set({
        state: "failed",
        error: `resident exited: ${String(detail)}`,
      });
    }
  }
  async #waitExit(ms: number): Promise<boolean> {
    if (!this.#resident || this.#ended) return true;
    const controller = new AbortController();
    try {
      return await Promise.race([
        this.#resident.exited.then(() => true, () => true),
        this.deps.delay(ms, controller.signal).then(() => false),
      ]);
    } finally {
      controller.abort();
    }
  }
  async #stopResident(publish = true) {
    if (this.#resident && !this.#ended) {
      await this.#resident.signalPid(15).catch(() => {});
      if (!await this.#waitExit(10_000)) {
        await this.#resident.signalPid(9).catch(() => {});
        if (!await this.#waitExit(5_000)) {
          this.#set({ state: "stuck", error: "resident exit unconfirmed" });
          return;
        }
      }
    }
    this.#resident = undefined;
    await this.#finite(`exec rm -f ${quote(this.spec.dir + "/server.pid")}`);
    if (publish) this.#set({ state: "stopped" });
  }
  async #ready(
    session: string,
    prefix: string,
    signal: AbortSignal,
    deadline: number,
  ) {
    while (this.deps.now() < deadline) {
      signal.throwIfAborted();
      let path = this.spec.readyPath(prefix);
      try {
        for (let redirects = 0; redirects <= 4; redirects++) {
          const remaining = deadline - this.deps.now();
          if (remaining <= 0) break;
          const response = await this.#probe({
            app: this.spec.id,
            session,
            prefix,
            method: "GET",
            path,
            headers: [],
            signal,
            timeoutMs: Math.min(30_000, remaining),
          });
          const headers = new Headers(response.headers);
          if ([301, 302, 307, 308].includes(response.status)) {
            const location = headers.get("location");
            if (!location || redirects === 4) {
              throw new Error("readiness redirect limit");
            }
            const origin = `http://127.0.0.1:${this.deps.servicePort}`;
            path = new URL(location, origin + path).pathname +
              new URL(location, origin + path).search;
            validateGuestPath(this.spec.id, session, prefix, path);
            continue;
          }
          if (this.spec.isReady(response)) return;
          break;
        }
      } catch {
        signal.throwIfAborted();
      }
      const remaining = deadline - this.deps.now();
      if (remaining > 0) {
        await this.deps.delay(Math.min(1000, remaining), signal);
      }
    }
    throw new Error(`${this.spec.title} readiness timed out after 240 seconds`);
  }
  #ctx(startup?: AbortSignal, generation?: number): GuestAppContext {
    return {
      finite: (line, stdin, timeoutMs) => {
        startup?.throwIfAborted();
        if (generation !== undefined && generation !== this.#generation) {
          return Promise.reject(resetCancelled);
        }
        return this.#finite(line, stdin, timeoutMs);
      },
      asset: (name) => {
        startup?.throwIfAborted();
        if (generation !== undefined && generation !== this.#generation) {
          return Promise.reject(resetCancelled);
        }
        return this.#asset(name, startup);
      },
    };
  }
  #asset(name: string, startup?: AbortSignal): Promise<Uint8Array> {
    const timeout = AbortSignal.timeout(30_000);
    const signal = startup ? AbortSignal.any([startup, timeout]) : timeout;
    return this.#cancellable(this.deps.asset(name, signal), signal);
  }
  async #cancellable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
    signal.throwIfAborted();
    let abort = () => {};
    const cancelled = new Promise<never>((_, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
    });
    try {
      return await Promise.race([work, cancelled]);
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }
  #probe(options: GuestHttpOptions): Promise<GuestHttpReply> {
    options.signal.throwIfAborted();
    return this.#cancellable(this.deps.request(options), options.signal);
  }
  async request(r: GuestAppRequest): Promise<GuestHttpReply> {
    if (
      this.#snapshot.state !== "running" || r.session !== this.#snapshot.session
    ) throw new GuestHttpError(`${this.spec.title} owner is stopped`, 503);
    const key = r.session + ":" + r.requestId;
    if (this.#requests.has(key)) {
      throw new GuestHttpError("duplicate request", 502);
    }
    const controller = new AbortController();
    this.#requests.set(key, controller);
    const budget = this.#budget;
    let reserved = 0;
    const take = (bytes: number) => {
      controller.signal.throwIfAborted();
      budget.take(bytes);
      reserved += bytes;
    };
    try {
      take(r.body?.byteLength ?? 0);
      const release = await this.deps.queue.acquire(
        r.session,
        controller.signal,
      );
      try {
        const cookie = this.#jar.header(r.path, Date.now()) || undefined;
        const { setCookies, ...reply } = await this.#probe({
          ...r,
          app: this.spec.id,
          prefix: this.#snapshot.prefix!,
          signal: controller.signal,
          cookie,
          onBuffer: take,
        });
        controller.signal.throwIfAborted();
        for (const raw of setCookies ?? []) {
          if (this.#jar.set(raw, r.path, Date.now()) === "rejected") {
            console.warn(
              `${this.spec.title}: cookie jar full, Set-Cookie rejected`,
            );
          }
        }
        return reply;
      } finally {
        release();
      }
    } finally {
      budget.give(reserved);
      if (this.#requests.get(key) === controller) this.#requests.delete(key);
    }
  }
  abort(session: string, requestId: string) {
    this.#requests.get(session + ":" + requestId)?.abort();
  }
}
