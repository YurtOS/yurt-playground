import type { ResidentHandle } from "./boot.ts";
import {
  GuestHttpError,
  type GuestHttpOptions,
  type GuestHttpReply,
  validateGuestPath,
} from "./guest_http.ts";
import {
  type DatasetteSnapshot,
  type GuestReply,
  type LifecycleReply,
  parseGuestAbort,
  parseGuestRequest,
  parseLifecycleMessage,
} from "./datasette_protocol.ts";
export interface DatasetteDependencies {
  uuid(): string;
  now(): number;
  delay(ms: number, signal?: AbortSignal): Promise<void>;
  startResident(line: string): Promise<ResidentHandle>;
  finite(
    line: string,
    stdin?: Uint8Array,
    timeoutMs?: number,
  ): Promise<{ code: number; stdout: string; stderr: string }>;
  seedSource(signal: AbortSignal): Promise<Uint8Array>;
  request(options: GuestHttpOptions): Promise<GuestHttpReply>;
  changed(snapshot: DatasetteSnapshot): void;
}
export const DATASETTE_DIR = "/home/user/demos/datasette";
export const DATASETTE_DB = DATASETTE_DIR + "/orders.db";
export const DATASETTE_QUERY =
  "SELECT product, SUM(quantity * unit_price_cents) AS revenue_cents FROM orders GROUP BY product ORDER BY revenue_cents DESC, product;";
const quote = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'";
type DemoRequest = {
  session: string;
  requestId: string;
  method: "GET" | "HEAD";
  path: string;
  headers: [string, string][];
};
export class DatasetteDemo {
  #snapshot: DatasetteSnapshot = { state: "stopped" };
  #resident?: ResidentHandle;
  #ended = false;
  #generation = 0;
  #startup?: AbortController;
  #starting?: Promise<DatasetteSnapshot>;
  #setup: Promise<void> = Promise.resolve();
  #cleanup: Promise<unknown> = Promise.resolve();
  #requests = new Map<string, AbortController>();
  constructor(readonly deps: DatasetteDependencies) {}
  get snapshot(): DatasetteSnapshot {
    return { ...this.#snapshot };
  }
  #set(snapshot: DatasetteSnapshot) {
    this.#snapshot = snapshot;
    this.deps.changed(this.snapshot);
  }
  #cancelRequests() {
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
    const session = this.deps.uuid();
    const prefix = `/apps/datasette/${session}/`;
    validateGuestPath(session, prefix, prefix);
    this.#set({ state: "starting", session, prefix });
    let started = 0;
    this.#setup = (async () => {
      await this.#cleanup;
      controller.signal.throwIfAborted();
      const source = await this.#seed(controller.signal);
      controller.signal.throwIfAborted();
      await this.#finite(
        `mkdir -p ${quote(DATASETTE_DIR)} && exec sh -c ${
          quote(`cat > ${DATASETTE_DIR}/datasette_seed.py`)
        }`,
        source,
      );
      controller.signal.throwIfAborted();
      await this.#finite(
        `exec python3 ${quote(DATASETTE_DIR + "/datasette_seed.py")}`,
      );
      controller.signal.throwIfAborted();
      const resident = await this.deps.startResident(
        `echo $$ > ${
          quote(DATASETTE_DIR + "/server.pid")
        } && exec python3 -m datasette serve ${
          quote(DATASETTE_DB)
        } --host 127.0.0.1 --port 8001 --setting base_url ${
          quote(prefix)
        } --setting default_cache_ttl 0 > ${
          quote(DATASETTE_DIR + "/server.log")
        } 2>&1`,
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
            quote(DATASETTE_DIR + "/server.pid")
          } ] && [ $i -lt 5 ]; do sleep 1; i=$((i+1)); done; exec cat ${
            quote(DATASETTE_DIR + "/server.pid")
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
              `exec tail -c 8192 ${quote(DATASETTE_DIR + "/server.log")}`,
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
    const stopped = this.stop(), generation = this.#generation;
    return stopped.then(() =>
      this.#serialize(async () => {
        if (generation !== this.#generation) return this.snapshot;
        try {
          if (this.#resident && !this.#ended) {
            throw new Error("resident exit unconfirmed");
          }
          this.#set({ state: "stopping" });
          const source = await this.#seed();
          if (generation !== this.#generation) return this.snapshot;
          await this.#finite(
            `mkdir -p ${quote(DATASETTE_DIR)} && exec sh -c ${
              quote(`cat > ${DATASETTE_DIR}/datasette_seed.py`)
            }`,
            source,
          );
          if (generation !== this.#generation) return this.snapshot;
          await this.#finite(
            `exec python3 ${
              quote(DATASETTE_DIR + "/datasette_seed.py")
            } --reset`,
          );
          if (generation === this.#generation) this.#set({ state: "stopped" });
          return this.snapshot;
        } catch (error) {
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
      })
    );
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
    if (
      this.#snapshot.state === "stuck" || this.#snapshot.state === "stopping"
    ) this.#set({ state: "stopped" });
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
  async #stopResident() {
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
    await this.#finite(`exec rm -f ${quote(DATASETTE_DIR + "/server.pid")}`);
    this.#set({ state: "stopped" });
  }
  async #ready(
    session: string,
    prefix: string,
    signal: AbortSignal,
    deadline: number,
  ) {
    while (this.deps.now() < deadline) {
      signal.throwIfAborted();
      let path = prefix + "orders.json?sql=SELECT+1+AS+ready&_shape=array";
      try {
        for (let redirects = 0; redirects <= 4; redirects++) {
          const remaining = deadline - this.deps.now();
          if (remaining <= 0) break;
          const response = await this.#probe({
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
            path = new URL(location, "http://127.0.0.1:8001" + path).pathname +
              new URL(location, "http://127.0.0.1:8001" + path).search;
            validateGuestPath(session, prefix, path);
            continue;
          }
          if (
            response.status === 200 &&
            /^application\/json(?:;|$)/i.test(headers.get("content-type") ?? "")
          ) {
            const value = JSON.parse(new TextDecoder().decode(response.body));
            if (
              Array.isArray(value) && value.length === 1 && value[0] !== null &&
              typeof value[0] === "object" &&
              Object.keys(value[0]).length === 1 && value[0].ready === 1
            ) return;
          }
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
    throw new Error("Datasette readiness timed out after 240 seconds");
  }
  #seed(startup?: AbortSignal): Promise<Uint8Array> {
    const timeout = AbortSignal.timeout(30_000);
    const signal = startup ? AbortSignal.any([startup, timeout]) : timeout;
    return this.#cancellable(this.deps.seedSource(signal), signal);
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
  async request(r: DemoRequest): Promise<GuestHttpReply> {
    if (
      this.#snapshot.state !== "running" || r.session !== this.#snapshot.session
    ) throw new GuestHttpError("Datasette owner is stopped", 503);
    const key = r.session + ":" + r.requestId;
    if (this.#requests.has(key)) {
      throw new GuestHttpError("duplicate request", 502);
    }
    const controller = new AbortController();
    this.#requests.set(key, controller);
    try {
      return await this.#probe({
        ...r,
        prefix: this.#snapshot.prefix!,
        signal: controller.signal,
      });
    } finally {
      if (this.#requests.get(key) === controller) this.#requests.delete(key);
    }
  }
  abort(session: string, requestId: string) {
    this.#requests.get(session + ":" + requestId)?.abort();
  }
}

export async function handleDatasetteMessage(
  demo: DatasetteDemo | undefined,
  value: unknown,
  send: (reply: GuestReply | LifecycleReply, transfer?: Transferable[]) => void,
): Promise<boolean> {
  const lifecycle = parseLifecycleMessage(value);
  if (lifecycle) {
    try {
      if (!demo) {
        throw new Error("Datasette requires a qualified browser image");
      }
      const snapshot = await (lifecycle.type === "datasette-start"
        ? demo.start()
        : lifecycle.type === "datasette-stop"
        ? demo.stop()
        : demo.reset());
      send({
        type: "datasette-state",
        requestId: lifecycle.requestId,
        snapshot,
      });
    } catch (error) {
      send({
        type: "datasette-state",
        requestId: lifecycle.requestId,
        snapshot: demo?.snapshot.state === "stuck" ? demo.snapshot : {
          state: "failed",
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }
    return true;
  }
  const abort = parseGuestAbort(value);
  if (abort) {
    demo?.abort(abort.session, abort.requestId);
    return true;
  }
  const request = parseGuestRequest(value);
  if (!request) return false;
  try {
    if (!demo) {
      throw new GuestHttpError(
        "Datasette requires a qualified browser image",
        503,
      );
    }
    const reply = await demo.request(request);
    send({
      type: "guest-http-response",
      session: request.session,
      requestId: request.requestId,
      ...reply,
    }, [reply.body]);
  } catch (error) {
    send({
      type: "guest-http-error",
      session: request.session,
      requestId: request.requestId,
      code: error instanceof GuestHttpError
        ? error.status
        : error instanceof DOMException
        ? 503
        : 502,
      message: error instanceof Error ? error.message : String(error),
    });
  }
  return true;
}
