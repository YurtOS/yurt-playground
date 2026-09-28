import { bridgeErrorResponse, guestResponse } from "./datasette_policy.ts";
import {
  type OwnerMessage,
  parseGuestReply,
  parseOwnerMessage,
} from "./datasette_protocol.ts";
import {
  GuestHttpError,
  type GuestHttpReply,
  type GuestMethod,
  validateGuestPath,
} from "./guest_http.ts";
export interface OwnerClient {
  id: string;
  url: string;
  postMessage(message: unknown): void;
}
interface RouteDependencies {
  origin: string;
  client(id: string): Promise<OwnerClient | undefined>;
  owners(): Promise<OwnerClient[]>;
  requestTimeoutMs?: number;
  recoveryMs?: number;
}
interface Owner {
  clientId: string;
  port: MessagePort;
  prefix: string;
  hashes: string[];
}
interface Pending {
  owner: Owner;
  resolve(reply: GuestHttpReply): void;
  reject(error: unknown): void;
}
interface Recovery {
  nonce: string;
  claims: Set<string>;
  done: Promise<void>;
  timer: number;
  resolve(): void;
  failed: boolean;
}
export class DatasetteRoutes {
  #owners = new Map<string, Owner>();
  #pending = new Map<string, Pending>();
  #recoveries = new Map<string, Recovery>();
  constructor(private readonly deps: RouteDependencies) {}
  #root(client: OwnerClient) {
    const url = new URL(client.url);
    return url.origin === this.deps.origin &&
      (url.pathname === "/" || url.pathname === "/index.html");
  }
  async register(
    client: OwnerClient,
    value: unknown,
    port: MessagePort,
  ): Promise<void> {
    const msg = parseOwnerMessage(value);
    if (!msg || msg.type !== "datasette-register" || !this.#root(client)) {
      throw new Error("invalid Datasette owner");
    }
    const live = await this.deps.client(client.id);
    if (!live || live.url !== client.url) {
      throw new Error("Datasette owner disappeared");
    }
    const recovery = this.#recoveries.get(msg.session);
    if (recovery && msg.nonce !== recovery.nonce) {
      throw new Error("expired recovery nonce");
    }
    if (recovery) {
      recovery.claims.add(client.id);
      if (recovery.claims.size > 1) {
        recovery.failed = true;
        this.#drop(msg.session);
        throw new Error("multiple Datasette owner claims");
      }
    }
    const old = this.#owners.get(msg.session);
    if (old && old.clientId !== client.id) {
      throw new Error("Datasette session already has an owner");
    }
    if (old) this.#drop(msg.session);
    const owner = {
      clientId: client.id,
      port,
      prefix: msg.prefix!,
      hashes: msg.hashes!,
    };
    this.#owners.set(msg.session, owner);
    port.onmessage = (event) => {
      const reply = parseGuestReply(event.data);
      if (
        !reply || reply.session !== msg.session ||
        this.#owners.get(msg.session) !== owner
      ) return;
      const pending = this.#pending.get(reply.session + ":" + reply.requestId);
      if (!pending || pending.owner !== owner) return;
      if (reply.type === "guest-http-response") pending.resolve(reply);
      else pending.reject(new GuestHttpError(reply.message, reply.code));
    };
    port.onmessageerror = () => this.#drop(msg.session);
    port.start();
    port.postMessage({
      type: "datasette-registered",
      session: msg.session,
      nonce: msg.nonce,
    });
  }
  ping(client: OwnerClient, msg: OwnerMessage): boolean {
    return this.#root(client) &&
      this.#owners.get(msg.session)?.clientId === client.id;
  }
  unregister(clientId: string, session: string) {
    if (this.#owners.get(session)?.clientId === clientId) this.#drop(session);
  }
  #drop(session: string) {
    const owner = this.#owners.get(session);
    if (!owner) return;
    this.#owners.delete(session);
    for (const [key, pending] of this.#pending) {
      if (pending.owner === owner) {
        pending.reject(new GuestHttpError("Datasette owner stopped", 503));
        this.#pending.delete(key);
      }
    }
    owner.port.close();
  }
  async #recover(session: string) {
    let recovery = this.#recoveries.get(session);
    if (!recovery) {
      const completion = Promise.withResolvers<void>();
      const record: Recovery = {
        nonce: crypto.randomUUID(),
        claims: new Set(),
        done: completion.promise,
        timer: 0,
        resolve: completion.resolve,
        failed: false,
      };
      this.#recoveries.set(session, record);
      recovery = record;
      record.timer = setTimeout(
        () => completion.resolve(),
        this.deps.recoveryMs ?? 5000,
      );
      try {
        for (const client of await this.deps.owners()) {
          if (this.#root(client)) {
            client.postMessage({
              type: "datasette-find-owner",
              session,
              nonce: record.nonce,
            });
          }
        }
      } catch {
        record.failed = true;
        completion.resolve();
      }
    }
    await recovery.done;
    if (this.#recoveries.get(session) === recovery) {
      clearTimeout(recovery.timer);
      this.#recoveries.delete(session);
    }
    if (recovery.failed || recovery.claims.size !== 1) {
      this.#drop(session);
      throw new GuestHttpError("Datasette owner missing or ambiguous", 503);
    }
  }
  async respond(request: Request): Promise<Response> {
    const method: GuestMethod = request.method === "HEAD" ? "HEAD" : "GET";
    const url = new URL(request.url);
    const match = /^\/apps\/datasette\/([0-9a-f-]{36})\//i.exec(url.pathname);
    let hashes: string[] = [];
    try {
      if (request.method !== "GET" && request.method !== "HEAD") {
        throw new GuestHttpError("Only GET and HEAD are supported", 405);
      }
      if (request.headers.has("upgrade")) {
        throw new GuestHttpError("HTTP upgrades are unsupported", 502);
      }
      if (!match || url.origin !== this.deps.origin) {
        throw new GuestHttpError("Datasette route unavailable", 503);
      }
      const session = match[1],
        prefix = `/apps/datasette/${session}/`,
        path = url.pathname + url.search;
      validateGuestPath(session, prefix, path);
      request.signal.throwIfAborted();
      const deadline = performance.now() +
        (this.deps.requestTimeoutMs ?? 30_000);
      if (!this.#owners.has(session) || this.#recoveries.has(session)) {
        const cancelled = Promise.withResolvers<never>();
        const abort = () =>
          cancelled.reject(new GuestHttpError("Guest request cancelled", 503));
        request.signal.addEventListener("abort", abort, { once: true });
        try {
          await Promise.race([this.#recover(session), cancelled.promise]);
        } finally {
          request.signal.removeEventListener("abort", abort);
        }
      }
      const owner = this.#owners.get(session);
      if (!owner || !await this.deps.client(owner.clientId)) {
        this.#drop(session);
        throw new GuestHttpError("Datasette owner disappeared", 503);
      }
      hashes = owner.hashes;
      request.signal.throwIfAborted();
      const requestId = crypto.randomUUID(), key = session + ":" + requestId;
      const pending = Promise.withResolvers<GuestHttpReply>();
      this.#pending.set(key, {
        owner,
        resolve: pending.resolve,
        reject: pending.reject,
      });
      const abort = () => {
        owner.port.postMessage({ type: "datasette-abort", session, requestId });
        pending.reject(new GuestHttpError("Guest request cancelled", 503));
      };
      request.signal.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(() => {
        owner.port.postMessage({ type: "datasette-abort", session, requestId });
        pending.reject(new GuestHttpError("Guest request deadline", 504));
      }, Math.max(0, deadline - performance.now()));
      try {
        const headers: [string, string][] = [];
        for (
          const name of [
            "Accept",
            "Accept-Language",
            "If-None-Match",
            "If-Modified-Since",
          ]
        ) {
          const value = request.headers.get(name);
          if (value !== null) headers.push([name, value]);
        }
        owner.port.postMessage({
          type: "datasette-http",
          session,
          requestId,
          method,
          path,
          headers,
        });
        return guestResponse(await pending.promise, method, hashes);
      } finally {
        clearTimeout(timer);
        request.signal.removeEventListener("abort", abort);
        this.#pending.delete(key);
      }
    } catch (error) {
      return bridgeErrorResponse(
        error instanceof GuestHttpError ? error.status : 502,
        error instanceof Error ? error.message : String(error),
        method,
        hashes,
      );
    }
  }
  dispose() {
    for (const session of [...this.#owners.keys()]) this.#drop(session);
    for (const r of this.#recoveries.values()) {
      clearTimeout(r.timer);
      r.failed = true;
      r.resolve();
    }
    this.#recoveries.clear();
  }
}
