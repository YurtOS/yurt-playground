/**
 * The Yurt network relay: how a playground tab's sandbox reaches the
 * internet when its user turns network on (yurt-playground#380).
 *
 * - `GET /token`: a short-lived token bound to the caller's address, only
 *   for a page on an allowed origin, a few per address per minute.
 * - `GET /dns?name=&token=`: the name's public IPv4 addresses.
 * - `GET /tcp?host=&port=&token=` (WebSocket): one TCP connection to a
 *   public IPv4 address on port 80, 443 or 9418. The relay answers the
 *   text frame `ok` once the connection is up; after that every binary
 *   frame is stream bytes, both ways, and the page may send the text
 *   frames `pause` and `resume` to stop and restart the server's bytes
 *   while its reader falls behind. A refusal or failure is a close with
 *   code `4000 + errno` (Linux numbering), which the page hands the guest
 *   as that errno.
 *
 * The relay sees which names are resolved, which addresses are reached
 * and how many bytes pass; TLS stays end to end between the guest and the
 * server, so it never sees content. No UDP.
 *
 * Platform-neutral: `worker.js` (Cloudflare) and `deno.ts` (local, tests)
 * supply resolution, TCP, the WebSocket upgrade and the caller's address.
 */
import {
  ALLOWED_PORTS,
  isHostname,
  isIpv4,
  isPublicAddress,
} from "./policy.ts";
import { issueToken, verifyToken } from "./token.ts";

/** One TCP connection, once it is up. */
export type RelayConnection = {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  close(): void;
};

/** The server side of an accepted WebSocket. */
export type RelayWebSocket = {
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    type: "message",
    listener: (event: { data: unknown }) => void,
  ): void;
  addEventListener(type: "close" | "error", listener: () => void): void;
  /** Bytes sent but not yet on the wire, where the platform says (Deno
   * does; Workers do not). */
  readonly bufferedAmount?: number;
};

export type Limits = {
  tokenTtlMs: number;
  /** Tokens one address may get per minute. */
  tokensPerMinute: number;
  socketsPerToken: number;
  bytesPerToken: number;
  idleMs: number;
  connectMs: number;
  /** Bytes from the page the server has not taken yet, at most. */
  upstreamQueueBytes: number;
  /** Bytes for the page queued on the WebSocket before reading pauses. */
  downstreamHighWater: number;
};

export const DEFAULT_LIMITS: Limits = {
  tokenTtlMs: 60 * 60 * 1000,
  tokensPerMinute: 10,
  socketsPerToken: 16,
  bytesPerToken: 1024 * 1024 * 1024,
  idleMs: 5 * 60 * 1000,
  connectMs: 15_000,
  upstreamQueueBytes: 4 * 1024 * 1024,
  downstreamHighWater: 1024 * 1024,
};

export type RelayPlatform = {
  /** The HMAC secret tokens are signed with: 32 characters at least. */
  secret: string;
  /** Page origins that may use the relay (`https://example.org`). */
  allowedOrigins: readonly string[];
  /** A name's IPv4 addresses (A records); none when it has none. */
  resolve(name: string): Promise<string[]>;
  /** Connect to `ip:port`; rejects when the connection fails. */
  connect(ip: string, port: number): Promise<RelayConnection>;
  /** Accept a WebSocket upgrade: the socket and the 101 response. */
  upgrade(request: Request): { socket: RelayWebSocket; response: Response };
  /** A platform's own limit on `/token` per address, on top of the
   * relay's (a Workers rate limiting binding counts across isolates). */
  allowToken?(client: string): Promise<boolean>;
  limits?: Partial<Limits>;
  now?: () => number;
};

// Linux errnos the page passes to the guest.
export const EACCES = 13;
export const ECONNREFUSED = 111;
export const ETIMEDOUT = 110;
export const ECONNRESET = 104;
export const EAGAIN = 11;
/** WebSocket close codes 4000-4999 are the application's. */
export const CLOSE_ERRNO_BASE = 4000;
const MIN_SECRET_LENGTH = 32;
const PAUSE_POLL_MS = 10;

type Usage = { open: number; bytes: number; expires: number };

export type Relay = {
  /** Serve `request` from `client`, the caller's address as the platform
   * saw it; a request without one is refused. */
  handle(request: Request, client: string | undefined): Promise<Response>;
  /** Live usage per token id, for tests. */
  usage: Map<string, Usage>;
};

/** Why a relay with this secret and these origins must not serve, or
 * `undefined` when it may. */
export function configProblem(
  secret: string | undefined,
  origins: readonly string[],
): string | undefined {
  if (secret === undefined || secret.length < MIN_SECRET_LENGTH) {
    return `RELAY_SECRET must be at least ${MIN_SECRET_LENGTH} characters`;
  }
  if (origins.length === 0) return "RELAY_ORIGINS is empty";
  for (const origin of origins) {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      return `RELAY_ORIGINS: ${origin} is not an origin`;
    }
    if (parsed.origin !== origin) {
      return `RELAY_ORIGINS: ${origin} is not an origin`;
    }
  }
  return undefined;
}

export function createRelay(platform: RelayPlatform): Relay {
  const problem = configProblem(platform.secret, platform.allowedOrigins);
  if (problem !== undefined) {
    throw new Error(`relay not configured: ${problem}`);
  }
  const limits = { ...DEFAULT_LIMITS, ...platform.limits };
  const now = platform.now ?? Date.now;
  // In memory: per server process (per isolate on Workers), so the caps
  // bound what one tab does through one relay instance; the token's
  // expiry bounds how long it can do it.
  const usage = new Map<string, Usage>();
  const tokensIssued = new Map<string, { count: number; since: number }>();

  /** Forget what can no longer matter: idle usage of expired tokens, and
   * token counts from past minutes. */
  const prune = () => {
    const t = now();
    for (const [id, use] of usage) {
      if (use.open === 0 && use.expires <= t) usage.delete(id);
    }
    for (const [client, issued] of tokensIssued) {
      if (t - issued.since >= 60_000) tokensIssued.delete(client);
    }
  };

  const mayIssue = async (client: string) => {
    prune();
    const issued = tokensIssued.get(client) ?? { count: 0, since: now() };
    if (issued.count >= limits.tokensPerMinute) return false;
    issued.count++;
    tokensIssued.set(client, issued);
    return await platform.allowToken?.(client) ?? true;
  };

  const cors = (origin: string): Record<string, string> => ({
    "Access-Control-Allow-Origin": origin,
    "Vary": "Origin",
    "Cache-Control": "no-store",
  });
  const json = (origin: string, body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...cors(origin), "Content-Type": "application/json" },
    });

  const tcp = (
    request: Request,
    url: URL,
    token: { id: string; expires: number },
  ): Response => {
    const host = url.searchParams.get("host") ?? "";
    const port = Number(url.searchParams.get("port"));
    const { socket, response } = platform.upgrade(request);
    const refuse = (errno: number, why: string) => {
      socket.close(CLOSE_ERRNO_BASE + errno, why);
      return response;
    };
    if (!ALLOWED_PORTS.has(port)) {
      return refuse(EACCES, `port ${port} is not 80, 443 or 9418`);
    }
    if (!isIpv4(host) || !isPublicAddress(host)) {
      return refuse(EACCES, `${host} is not a public IPv4 address`);
    }
    prune();
    const use = usage.get(token.id) ??
      { open: 0, bytes: 0, expires: token.expires };
    if (use.open >= limits.socketsPerToken) {
      return refuse(EAGAIN, `${limits.socketsPerToken} connections are open`);
    }
    if (use.bytes >= limits.bytesPerToken) {
      return refuse(EACCES, "this tab's data allowance is used up");
    }
    use.open++;
    usage.set(token.id, use);
    pipe(socket, host, port, use);
    return response;
  };

  const pipe = (
    socket: RelayWebSocket,
    host: string,
    port: number,
    use: Usage,
  ) => {
    let connection: RelayConnection | undefined;
    let writer: WritableStreamDefaultWriter<Uint8Array> | undefined;
    let writes = Promise.resolve();
    /** Bytes from the page not yet taken by the server. */
    let queued = 0;
    /** The page's reader is behind: hold the server's bytes. */
    let paused = false;
    let ended = false;
    let idle: ReturnType<typeof setTimeout> | undefined;
    // A connection lives no longer than its token.
    const expiry = setTimeout(
      () => end(CLOSE_ERRNO_BASE + EACCES, "the token expired"),
      Math.max(0, use.expires - now()),
    );
    const end = (code = 1000, why = "") => {
      if (ended) return;
      ended = true;
      clearTimeout(idle);
      clearTimeout(expiry);
      use.open--;
      try {
        connection?.close();
      } catch {
        // Already closed.
      }
      try {
        socket.close(code, why);
      } catch {
        // Already closed.
      }
    };
    const alive = () => {
      clearTimeout(idle);
      idle = setTimeout(
        () => end(CLOSE_ERRNO_BASE + ETIMEDOUT, "idle"),
        limits.idleMs,
      );
    };
    /** Count `n` bytes; false once the token's allowance is gone. */
    const count = (n: number) => {
      use.bytes += n;
      if (use.bytes <= limits.bytesPerToken) return true;
      end(
        CLOSE_ERRNO_BASE + ECONNRESET,
        "this tab's data allowance is used up",
      );
      return false;
    };
    socket.addEventListener("close", () => end());
    socket.addEventListener("error", () => end());
    socket.addEventListener("message", (event) => {
      if (ended) return;
      if (event.data === "pause" || event.data === "resume") {
        paused = event.data === "pause";
        return;
      }
      if (!(event.data instanceof ArrayBuffer) || writer === undefined) {
        end(CLOSE_ERRNO_BASE + ECONNRESET, "unexpected frame");
        return;
      }
      const bytes = new Uint8Array(event.data);
      if (!count(bytes.byteLength)) return;
      queued += bytes.byteLength;
      if (queued > limits.upstreamQueueBytes) {
        end(
          CLOSE_ERRNO_BASE + ECONNRESET,
          "sending faster than the server takes it",
        );
        return;
      }
      alive();
      const w = writer;
      writes = writes.then(() => w.write(bytes)).then(
        () => {
          queued -= bytes.byteLength;
        },
        () => end(CLOSE_ERRNO_BASE + ECONNRESET, "write failed"),
      );
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("timed out")),
        limits.connectMs,
      );
    });
    const connecting = platform.connect(host, port);
    Promise.race([connecting, timeout]).then(
      async (opened) => {
        clearTimeout(timer);
        if (ended) {
          // The page left while the connection was being made.
          opened.close();
          return;
        }
        connection = opened;
        writer = opened.writable.getWriter();
        socket.send("ok");
        alive();
        try {
          for await (const chunk of opened.readable) {
            if (ended || !count(chunk.byteLength)) break;
            alive();
            socket.send(chunk);
            // Backpressure: hold the server's bytes while the page asks,
            // or while the WebSocket still has a buffer's worth to send.
            while (
              !ended &&
              (paused ||
                (socket.bufferedAmount ?? 0) > limits.downstreamHighWater)
            ) {
              await new Promise((r) => setTimeout(r, PAUSE_POLL_MS));
            }
          }
          end();
        } catch {
          end(CLOSE_ERRNO_BASE + ECONNRESET, "connection reset");
        }
      },
      (error) => {
        clearTimeout(timer);
        // A connection that comes up after its timeout is closed then.
        connecting.then((late) => late.close(), () => {});
        const timedOut = error instanceof Error &&
          error.message === "timed out";
        end(
          CLOSE_ERRNO_BASE + (timedOut ? ETIMEDOUT : ECONNREFUSED),
          timedOut ? "connect timed out" : "connection refused",
        );
      },
    );
  };

  const handle = async (
    request: Request,
    client: string | undefined,
  ): Promise<Response> => {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") ?? "";
    if (!platform.allowedOrigins.includes(origin)) {
      return new Response("origin not allowed\n", { status: 403 });
    }
    if (client === undefined || client === "") {
      return new Response("no client address\n", {
        status: 400,
        headers: cors(origin),
      });
    }
    if (request.method !== "GET") {
      return new Response("GET only\n", { status: 405, headers: cors(origin) });
    }
    if (url.pathname === "/token") {
      if (!await mayIssue(client)) {
        return json(origin, { error: "too many tokens" }, 429);
      }
      return json(
        origin,
        await issueToken(platform.secret, client, now(), limits.tokenTtlMs),
      );
    }
    const token = await verifyToken(
      platform.secret,
      url.searchParams.get("token") ?? "",
      client,
      now(),
    );
    if (token === undefined) {
      return json(origin, { error: "no valid token" }, 401);
    }
    if (url.pathname === "/dns") {
      const name = (url.searchParams.get("name") ?? "").toLowerCase();
      if (!isHostname(name)) {
        return json(origin, { error: "not a host name" }, 400);
      }
      let addresses: string[];
      try {
        addresses = await platform.resolve(name);
      } catch {
        return json(origin, { error: "resolution failed" }, 502);
      }
      // Only what a connect would be let through to.
      return json(origin, {
        addresses: addresses.filter((ip) => isIpv4(ip) && isPublicAddress(ip)),
      });
    }
    if (url.pathname === "/tcp") {
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return new Response("WebSocket only\n", {
          status: 426,
          headers: cors(origin),
        });
      }
      return tcp(request, url, token);
    }
    return new Response("not found\n", { status: 404, headers: cors(origin) });
  };

  return { handle, usage };
}
