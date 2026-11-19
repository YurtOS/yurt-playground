/**
 * The Yurt network relay: how a playground tab's sandbox reaches the
 * internet when its user turns network on (yurt-playground#380).
 *
 * - `GET /token`: a short-lived per-tab token, only for a page on an
 *   allowed origin.
 * - `GET /dns?name=&token=`: the name's public IPv4 addresses.
 * - `GET /tcp?host=&port=&token=` (WebSocket): one TCP connection to a
 *   public IPv4 address on port 80, 443 or 9418. The relay answers the
 *   text frame `ok` once the connection is up; after that every binary
 *   frame is stream bytes, both ways. A refusal or failure is a close
 *   with code `4000 + errno` (Linux numbering), which the page hands the
 *   guest as that errno.
 *
 * The relay sees which names are resolved, which addresses are reached
 * and how many bytes pass; TLS stays end to end between the guest and the
 * server, so it never sees content. No UDP.
 *
 * Platform-neutral: `worker.js` (Cloudflare) and `deno.ts` (local, tests)
 * supply resolution, TCP and the WebSocket upgrade.
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
};

export type Limits = {
  tokenTtlMs: number;
  socketsPerToken: number;
  bytesPerToken: number;
  idleMs: number;
  connectMs: number;
};

export const DEFAULT_LIMITS: Limits = {
  tokenTtlMs: 60 * 60 * 1000,
  socketsPerToken: 16,
  bytesPerToken: 1024 * 1024 * 1024,
  idleMs: 5 * 60 * 1000,
  connectMs: 15_000,
};

export type RelayPlatform = {
  /** The HMAC secret tokens are signed with. */
  secret: string;
  /** Page origins that may use the relay (`https://example.org`). */
  allowedOrigins: readonly string[];
  /** A name's IPv4 addresses (A records); none when it has none. */
  resolve(name: string): Promise<string[]>;
  /** Connect to `ip:port`; rejects when the connection fails. */
  connect(ip: string, port: number): Promise<RelayConnection>;
  /** Accept a WebSocket upgrade: the socket and the 101 response. */
  upgrade(request: Request): { socket: RelayWebSocket; response: Response };
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

type Usage = { open: number; bytes: number };

export type Relay = {
  handle(request: Request): Promise<Response>;
  /** Live usage per token id, for tests. */
  usage: Map<string, Usage>;
};

export function createRelay(platform: RelayPlatform): Relay {
  const limits = { ...DEFAULT_LIMITS, ...platform.limits };
  const now = platform.now ?? Date.now;
  // In memory: per server process (per isolate on Workers), so the caps
  // bound what one tab does through one relay instance; the token's
  // expiry bounds how long it can do it.
  const usage = new Map<string, Usage>();

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

  const tokenId = (url: URL) =>
    verifyToken(platform.secret, url.searchParams.get("token") ?? "", now());

  const tcp = (request: Request, url: URL, id: string): Response => {
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
    const use = usage.get(id) ?? { open: 0, bytes: 0 };
    if (use.open >= limits.socketsPerToken) {
      return refuse(EAGAIN, `${limits.socketsPerToken} connections are open`);
    }
    if (use.bytes >= limits.bytesPerToken) {
      return refuse(EACCES, "this tab's data allowance is used up");
    }
    use.open++;
    usage.set(id, use);
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
    let ended = false;
    let idle: ReturnType<typeof setTimeout> | undefined;
    const end = (code = 1000, why = "") => {
      if (ended) return;
      ended = true;
      clearTimeout(idle);
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
      if (!(event.data instanceof ArrayBuffer) || writer === undefined) {
        end(CLOSE_ERRNO_BASE + ECONNRESET, "unexpected frame");
        return;
      }
      const bytes = new Uint8Array(event.data);
      if (!count(bytes.byteLength)) return;
      alive();
      const w = writer;
      writes = writes.then(() => w.write(bytes)).catch(() =>
        end(CLOSE_ERRNO_BASE + ECONNRESET, "write failed")
      );
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("timed out")),
        limits.connectMs,
      );
    });
    Promise.race([platform.connect(host, port), timeout]).then(
      async (opened) => {
        clearTimeout(timer);
        connection = opened;
        if (ended) {
          end();
          return;
        }
        writer = opened.writable.getWriter();
        socket.send("ok");
        alive();
        try {
          for await (const chunk of opened.readable) {
            if (ended || !count(chunk.byteLength)) break;
            alive();
            socket.send(chunk);
          }
          end();
        } catch {
          end(CLOSE_ERRNO_BASE + ECONNRESET, "connection reset");
        }
      },
      (error) => {
        clearTimeout(timer);
        const timedOut = error instanceof Error &&
          error.message === "timed out";
        end(
          CLOSE_ERRNO_BASE + (timedOut ? ETIMEDOUT : ECONNREFUSED),
          timedOut ? "connect timed out" : "connection refused",
        );
      },
    );
  };

  const handle = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") ?? "";
    if (!platform.allowedOrigins.includes(origin)) {
      return new Response("origin not allowed\n", { status: 403 });
    }
    if (request.method !== "GET") {
      return new Response("GET only\n", { status: 405, headers: cors(origin) });
    }
    if (url.pathname === "/token") {
      return json(
        origin,
        await issueToken(platform.secret, now(), limits.tokenTtlMs),
      );
    }
    const id = await tokenId(url);
    if (id === undefined) {
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
      return tcp(request, url, id);
    }
    return new Response("not found\n", { status: 404, headers: cors(origin) });
  };

  return { handle, usage };
}
