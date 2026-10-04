import { bridgeErrorResponse, guestResponse } from "./datasette_policy.ts";
import { GUEST_APPS, isGuestAppId } from "./guest_apps.ts";
import {
  type OwnerMessage,
  parseGuestReply,
  parseOwnerMessage,
} from "./datasette_protocol.ts";
import {
  GUEST_METHODS,
  GuestHttpError,
  type GuestHttpReply,
  type GuestMethod,
  validateGuestPath,
} from "./guest_http.ts";
import { REQUEST_DEADLINE_MS } from "./slot_queue.ts";
export const DEFAULT_REQUEST_TIMEOUT_MS = REQUEST_DEADLINE_MS;
const REQUEST_HEADERS = [
  "accept",
  "accept-language",
  "if-none-match",
  "if-modified-since",
  "if-match",
  "if-unmodified-since",
  "range",
  "if-range",
  "content-type",
  "x-requested-with",
  "x-csrf-token",
  "x-csrftoken",
  "x-xsrf-token",
  "authorization",
];
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
  log?: (message: string) => void;
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
  #loggedDrops = new Set<string>();
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
      if (reply.type === "datasette-response") pending.resolve(reply);
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
    for (const key of this.#loggedDrops) {
      if (key.startsWith(session + ":")) this.#loggedDrops.delete(key);
    }
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
    const method = request.method as GuestMethod;
    const url = new URL(request.url);
    const match = /^\/apps\/([a-z0-9-]+)\/([0-9a-f-]{36})\//.exec(url.pathname);
    const app = match?.[1];
    let hashes: string[] = [];
    try {
      if (!match || !isGuestAppId(app) || url.origin !== this.deps.origin) {
        throw new GuestHttpError("Guest app route unavailable", 503);
      }
      if (!GUEST_METHODS.has(method)) {
        throw new GuestHttpError("unsupported method", 405);
      }
      if (request.headers.has("upgrade")) {
        throw new GuestHttpError("HTTP upgrades are unsupported", 502);
      }
      if (request.destination === "document") {
        throw new GuestHttpError(
          "Open this page inside the preview panel; opening it in a new tab is not supported.",
          403,
        );
      }
      let referrerUrl: URL | undefined;
      if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
        try {
          referrerUrl = new URL(request.referrer);
        } catch {
          throw new GuestHttpError("unsafe request referrer unavailable", 403);
        }
        if (referrerUrl.origin !== this.deps.origin) {
          throw new GuestHttpError("unsafe request referrer unavailable", 403);
        }
      }
      let body: ArrayBuffer | undefined;
      if (method !== "GET" && method !== "HEAD") {
        const blob = await request.blob();
        if (blob.size > 16 * 1024 * 1024) {
          throw new GuestHttpError("request body exceeds 16 MiB", 413);
        }
        body = await blob.arrayBuffer();
      }
      const session = match[2],
        prefix = `/apps/${app}/${session}/`,
        path = url.pathname + url.search;
      validateGuestPath(app, session, prefix, path);
      let referrer: string | undefined;
      if (referrerUrl?.pathname.startsWith(prefix)) {
        const candidate = referrerUrl.pathname + referrerUrl.search;
        try {
          validateGuestPath(app, session, prefix, candidate);
          referrer = candidate;
        } catch {
          // A same-origin referrer outside the guest path is optional metadata.
        }
      }
      request.signal.throwIfAborted();
      const deadline = performance.now() +
        (this.deps.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
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
      if (!owner || owner.prefix !== prefix) {
        throw new GuestHttpError("Guest app owner unavailable", 503);
      }
      if (!await this.deps.client(owner.clientId)) {
        this.#drop(session);
        throw new GuestHttpError("Guest app owner disappeared", 503);
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
        for (const name of REQUEST_HEADERS) {
          const value = request.headers.get(name);
          if (value !== null) headers.push([name, value]);
        }
        owner.port.postMessage({
          type: "datasette-http",
          app,
          session,
          requestId,
          method,
          path,
          headers,
          body,
          referrer,
        }, body ? [body] : []);
        return guestResponse(await pending.promise, method, hashes, (name) => {
          const key = session + ":" + name;
          if (this.#loggedDrops.has(key)) return;
          this.#loggedDrops.add(key);
          (this.deps.log ?? console.warn)(
            `dropped guest response header ${name}`,
          );
        });
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
        isGuestAppId(app) ? GUEST_APPS[app].title : "Guest app",
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
