/**
 * The Yurt network relay: how a playground tab's sandbox reaches the
 * internet when its user turns network on (yurt-playground#380).
 *
 * - `GET /token?turnstile=`: a short-lived token bound to the caller's
 *   address, only for a page on an allowed origin that passed a Turnstile
 *   challenge, a few per caller per minute.
 * - `GET /dns?name=&token=`: the name's public IPv4 addresses.
 * - `GET /tcp?host=&port=&token=` (WebSocket): one TCP connection to a
 *   public IPv4 address on port 80, 443 or 9418. The relay answers the
 *   text frame `ok` once the connection is up; after that every binary
 *   frame is stream bytes, both ways. Every {@link Limits.seqEvery} bytes
 *   the relay sends the text frame `seq <nonce>`; once its guest has read
 *   everything before it, the page answers `ack <nonce>`, in order. Frames
 *   arrive in order, so quoting the nonce proves the page received those
 *   bytes. The relay stops reading from the server while more than
 *   {@link Limits.downstreamWindow} bytes are unacknowledged. A refusal or
 *   failure is a close with code
 *   `4000 + errno` (Linux numbering), which the page hands the guest as
 *   that errno.
 *
 * Callers are counted by {@link clientKey} (an IPv4 address, or an IPv6
 * /64): tokens per minute, connections, bytes and queued bytes are capped
 * per caller as well as per token. All counts live in this process (one
 * isolate on Workers); exact counts across isolates would need a Durable
 * Object.
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
  clientKey,
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
  /** A connection lives no longer than its token. */
  tokenTtlMs: number;
  /** Tokens per caller per minute. */
  tokensPerMinute: number;
  /** `/dns` questions per token, and per caller, per minute. */
  dnsPerMinute: number;
  dnsPerClientPerMinute: number;
  socketsPerToken: number;
  socketsPerClient: number;
  bytesPerToken: number;
  /** Bytes per caller per {@link clientWindowMs}. */
  bytesPerClient: number;
  clientWindowMs: number;
  /** No byte either way for this long ends a connection; so does this
   * long without credit from the page. */
  idleMs: number;
  connectMs: number;
  /** Bytes from the page the server has not taken yet, at most: per
   * connection, per caller, and in all. */
  upstreamQueueBytes: number;
  upstreamQueuePerClient: number;
  upstreamQueueTotal: number;
  /** An upstream write the server has not taken within this long ends
   * its connection. */
  writeStallMs: number;
  /** Bytes sent to the page and not yet acknowledged, at most: per
   * connection (reading pauses), per caller (its largest holder is cut)
   * and in all (the caller holding the most is cut). */
  downstreamWindow: number;
  downstreamPerClient: number;
  downstreamTotal: number;
  /** Bytes between two `seq` frames. */
  seqEvery: number;
};

export const DEFAULT_LIMITS: Limits = {
  tokenTtlMs: 20 * 60 * 1000,
  tokensPerMinute: 10,
  dnsPerMinute: 120,
  dnsPerClientPerMinute: 600,
  socketsPerToken: 16,
  socketsPerClient: 32,
  bytesPerToken: 1024 * 1024 * 1024,
  bytesPerClient: 2 * 1024 * 1024 * 1024,
  clientWindowMs: 60 * 60 * 1000,
  idleMs: 5 * 60 * 1000,
  connectMs: 15_000,
  upstreamQueueBytes: 4 * 1024 * 1024,
  upstreamQueuePerClient: 16 * 1024 * 1024,
  upstreamQueueTotal: 64 * 1024 * 1024,
  writeStallMs: 45_000,
  downstreamWindow: 2 * 1024 * 1024,
  downstreamPerClient: 16 * 1024 * 1024,
  downstreamTotal: 32 * 1024 * 1024,
  seqEvery: 256 * 1024,
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
  /** A platform's own limit on `/token` per caller ({@link clientKey}),
   * on top of the relay's. */
  allowToken?(client: string): Promise<boolean>;
  /** Whether a Turnstile response from `address` is a human's
   * ({@link siteverify}). Required: no token without it. */
  verifyHuman(response: string, address: string): Promise<boolean>;
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
/** Bookkeeping of the past is swept at most this often. */
const PRUNE_EVERY_MS = 30_000;

/** An open connection, as the isolate-wide budgets see it. */
type Live = {
  client: string;
  queued(): number;
  unacked(): number;
  ackedAt(): number;
  writingSince(): number;
  end(code: number, why: string): void;
};

type Usage = {
  open: number;
  bytes: number;
  queued: number;
  unacked: number;
  /** When an idle entry may be forgotten (a token's expiry; the end of a
   * caller's byte window, when its bytes start over). */
  until: number;
};

export type Relay = {
  /** Serve `request` from `client`, the caller's address as the platform
   * saw it; a request without one is refused. */
  handle(request: Request, client: string | undefined): Promise<Response>;
  /** Live usage per token id and per caller, for tests. */
  usage: { tokens: Map<string, Usage>; clients: Map<string, Usage> };
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

/** `RELAY_ORIGINS`, comma-separated, as a list. */
export function originsOf(text: string | undefined): string[] {
  return (text ?? "").split(",").map((o) => o.trim()).filter((o) => o !== "");
}

/** The Worker's environment as worker.js reads it. */
export type WorkerEnv = {
  RELAY_SECRET?: string;
  RELAY_ORIGINS?: string;
  TURNSTILE_SECRET?: string;
  TOKEN_LIMITER?: {
    limit(options: { key: string }): Promise<{ success: boolean }>;
  };
};

/** Why the Worker must not serve: {@link configProblem}, no
 * `TURNSTILE_SECRET`, or no `TOKEN_LIMITER` binding. */
export function workerConfigProblem(env: WorkerEnv): string | undefined {
  return configProblem(env.RELAY_SECRET, originsOf(env.RELAY_ORIGINS)) ??
    (!env.TURNSTILE_SECRET
      ? "TURNSTILE_SECRET is not set"
      : TURNSTILE_TEST_SECRETS.includes(env.TURNSTILE_SECRET)
      ? "TURNSTILE_SECRET is one of Cloudflare's test secrets"
      : undefined) ??
    (typeof env.TOKEN_LIMITER?.limit === "function"
      ? undefined
      : "the TOKEN_LIMITER rate limiting binding is missing");
}

const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/** The `action` the page's widget runs: siteverify must report it. */
export const TURNSTILE_ACTION = "relay-token";

/** Cloudflare's published Turnstile test secrets: siteverify answers them
 * for any response (hostname example.com, no action). For local runs and
 * tests only; the Worker refuses them. */
export const TURNSTILE_TEST_SECRETS: readonly string[] = [
  "1x0000000000000000000000000000000AA",
  "2x0000000000000000000000000000000AA",
  "3x0000000000000000000000000000000AA",
];

/** What a real answer must say besides success: one of the site's
 * hostnames, and the widget's action. */
export type HumanExpectations = { hostnames: string[]; action: string };

/** The hostnames of `origins`. */
export function hostnamesOf(origins: readonly string[]): string[] {
  return origins.map((origin) => new URL(origin).hostname);
}

/** Ask Cloudflare whether `response`, a Turnstile widget's answer given to
 * the caller at `address`, is good under `secret` and, with `expect`, was
 * given on one of the site's hostnames for {@link TURNSTILE_ACTION}. A
 * failure to ask is a no. */
export async function siteverify(
  secret: string,
  response: string,
  address: string,
  expect: HumanExpectations | undefined,
  fetchFn: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const answer = await fetchFn(SITEVERIFY, {
      method: "POST",
      body: new URLSearchParams({ secret, response, remoteip: address }),
    });
    if (!answer.ok) return false;
    const result = await answer.json() as {
      success?: unknown;
      hostname?: unknown;
      action?: unknown;
    };
    if (result.success !== true) return false;
    if (expect === undefined) return true;
    return typeof result.hostname === "string" &&
      expect.hostnames.includes(result.hostname) &&
      result.action === expect.action;
  } catch {
    return false;
  }
}

function nonce(): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(9))))
    .replaceAll("+", "-").replaceAll("/", "_");
}

/** At most `limit` per key per `windowMs`; old windows are swept at most
 * once per window. */
function windowCounter(limit: number, windowMs: number, now: () => number) {
  const counts = new Map<string, { count: number; since: number }>();
  let swept = now();
  return (key: string): boolean => {
    const t = now();
    if (t - swept >= windowMs) {
      swept = t;
      for (const [k, c] of counts) {
        if (t - c.since >= windowMs) counts.delete(k);
      }
    }
    let c = counts.get(key);
    if (c === undefined || t - c.since >= windowMs) {
      c = { count: 0, since: t };
      counts.set(key, c);
    }
    if (c.count >= limit) return false;
    c.count++;
    return true;
  };
}

export function createRelay(platform: RelayPlatform): Relay {
  const problem = configProblem(platform.secret, platform.allowedOrigins);
  if (problem !== undefined) {
    throw new Error(`relay not configured: ${problem}`);
  }
  if (typeof platform.verifyHuman !== "function") {
    throw new Error("relay not configured: no Turnstile verification");
  }
  const limits = { ...DEFAULT_LIMITS, ...platform.limits };
  const now = platform.now ?? Date.now;
  const tokens = new Map<string, Usage>();
  const clients = new Map<string, Usage>();
  /** Bytes from every page not yet taken by their servers. */
  let queuedTotal = 0;
  /** Bytes sent to every page and not yet acknowledged. */
  let unackedTotal = 0;
  /** Every open connection, for the isolate-wide budgets' evictions. */
  const live = new Set<Live>();
  const mayIssue = windowCounter(limits.tokensPerMinute, 60_000, now);
  const mayAsk = windowCounter(limits.dnsPerMinute, 60_000, now);
  const mayClientAsk = windowCounter(
    limits.dnsPerClientPerMinute,
    60_000,
    now,
  );

  /** Cut every connection, among `among`, of the caller holding the most
   * `amount`; a tie goes to the caller whose `since` is oldest (the
   * longest without progress). False when no one holds any. */
  const evictHeaviest = (
    among: Iterable<Live>,
    amount: (c: Live) => number,
    since: (c: Live) => number,
  ): boolean => {
    const callers = new Map<string, { total: number; oldest: number }>();
    for (const c of among) {
      const a = amount(c);
      if (a <= 0) continue;
      const entry = callers.get(c.client) ?? { total: 0, oldest: Infinity };
      entry.total += a;
      entry.oldest = Math.min(entry.oldest, since(c));
      callers.set(c.client, entry);
    }
    let pick: { client: string; total: number; oldest: number } | undefined;
    for (const [client, e] of callers) {
      if (
        pick === undefined || e.total > pick.total ||
        (e.total === pick.total && e.oldest < pick.oldest)
      ) {
        pick = { client, ...e };
      }
    }
    if (pick === undefined) return false;
    for (const c of [...live]) {
      if (c.client === pick.client && amount(c) > 0) {
        c.end(CLOSE_ERRNO_BASE + ECONNRESET, "the relay is busy");
      }
    }
    return true;
  };
  /** Cut until `total()` is within `cap`; stops when a round frees
   * nothing. */
  const evictUntil = (
    total: () => number,
    cap: number,
    amount: (c: Live) => number,
    since: (c: Live) => number,
  ) => {
    while (total() > cap) {
      const before = total();
      if (!evictHeaviest(live, amount, since) || total() >= before) return;
    }
  };
  /** The isolate's queued upstream bytes are over budget: cut the caller
   * holding the most, not whoever sent the last frame. */
  const evictQueued = () =>
    evictUntil(
      () => queuedTotal,
      limits.upstreamQueueTotal,
      (c) => c.queued(),
      (c) => c.writingSince(),
    );
  /** The isolate's unacknowledged bytes are over budget: the same, by
   * the bytes the callers have not acknowledged. */
  const evictUnacked = () =>
    evictUntil(
      () => unackedTotal,
      limits.downstreamTotal,
      (c) => c.unacked(),
      (c) => c.ackedAt(),
    );

  let pruned = now();
  const prune = () => {
    const t = now();
    if (t - pruned < PRUNE_EVERY_MS) return;
    pruned = t;
    for (const map of [tokens, clients]) {
      for (const [key, use] of map) {
        if (
          use.open === 0 && use.queued === 0 && use.unacked === 0 &&
          use.until <= t
        ) {
          map.delete(key);
        }
      }
    }
  };

  const tokenUsage = (id: string, expires: number) => {
    let use = tokens.get(id);
    if (use === undefined) {
      use = { open: 0, bytes: 0, queued: 0, unacked: 0, until: expires };
      tokens.set(id, use);
    }
    return use;
  };
  const clientUsage = (key: string) => {
    let use = clients.get(key);
    const t = now();
    if (use === undefined) {
      use = {
        open: 0,
        bytes: 0,
        queued: 0,
        unacked: 0,
        until: t + limits.clientWindowMs,
      };
      clients.set(key, use);
    } else if (use.until <= t) {
      // A new window: the caller's bytes start over.
      use.bytes = 0;
      use.until = t + limits.clientWindowMs;
    }
    return use;
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
    client: string,
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
    const byToken = tokenUsage(token.id, token.expires);
    const byClient = clientUsage(client);
    if (
      byToken.open >= limits.socketsPerToken ||
      byClient.open >= limits.socketsPerClient
    ) {
      return refuse(EAGAIN, "too many connections are open");
    }
    if (
      byToken.bytes >= limits.bytesPerToken ||
      byClient.bytes >= limits.bytesPerClient
    ) {
      return refuse(EACCES, "the data allowance is used up");
    }
    byToken.open++;
    byClient.open++;
    pipe(socket, host, port, [byToken, byClient], token.expires, client);
    return response;
  };

  const pipe = (
    socket: RelayWebSocket,
    host: string,
    port: number,
    uses: [Usage, Usage],
    expires: number,
    client: string,
  ) => {
    const [byToken, byClient] = uses;
    let connection: RelayConnection | undefined;
    let writer: WritableStreamDefaultWriter<Uint8Array> | undefined;
    let writes = Promise.resolve();
    /** Bytes from the page not yet taken by the server. */
    let queued = 0;
    /** Bytes sent to the page, and how far the page acknowledged. */
    let sent = 0;
    let acked = 0;
    /** `seq` frames sent and not yet acknowledged: where each stood. */
    const marks: { nonce: string; at: number }[] = [];
    let sinceMark = 0;
    /** Wakes the read loop: credit arrived, or the connection ended. */
    let credited: (() => void) | undefined;
    let ended = false;
    let idle: ReturnType<typeof setTimeout> | undefined;
    /** The write in flight's deadline. */
    let stall: ReturnType<typeof setTimeout> | undefined;
    /** When the page last acknowledged (or the connection opened), and
     * since when bytes have been waiting for the server. */
    let ackedAt = now();
    let writingSince = Infinity;
    // A connection lives no longer than its token.
    const expiry = setTimeout(
      () => end(CLOSE_ERRNO_BASE + EACCES, "the token expired"),
      Math.max(0, expires - now()),
    );
    const unqueue = (n: number) => {
      queued -= n;
      byClient.queued -= n;
      queuedTotal -= n;
    };
    const end = (code = 1000, why = "") => {
      if (ended) return;
      ended = true;
      live.delete(self);
      clearTimeout(idle);
      clearTimeout(expiry);
      clearTimeout(stall);
      for (const use of uses) use.open--;
      unqueue(queued);
      unackedTotal -= sent - acked;
      byClient.unacked -= sent - acked;
      acked = sent;
      credited?.();
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
    /** Count `n` bytes; false once an allowance is gone. */
    const count = (n: number) => {
      byToken.bytes += n;
      byClient.bytes += n;
      if (
        byToken.bytes <= limits.bytesPerToken &&
        byClient.bytes <= limits.bytesPerClient
      ) {
        return true;
      }
      end(CLOSE_ERRNO_BASE + ECONNRESET, "the data allowance is used up");
      return false;
    };
    const self: Live = {
      client,
      queued: () => queued,
      unacked: () => sent - acked,
      ackedAt: () => ackedAt,
      writingSince: () => writingSince,
      end,
    };
    live.add(self);
    /** `ack <nonce>`: the oldest `seq` outstanding, or the page is lying. */
    const credit = (text: string) => {
      const mark = marks[0];
      if (mark === undefined || text !== `ack ${mark.nonce}`) {
        end(CLOSE_ERRNO_BASE + ECONNRESET, "bad acknowledgement");
        return;
      }
      marks.shift();
      unackedTotal -= mark.at - acked;
      byClient.unacked -= mark.at - acked;
      acked = mark.at;
      ackedAt = now();
      credited?.();
    };
    /** Send the server's `chunk`, and a `seq` frame past each
     * {@link Limits.seqEvery} bytes. */
    const sendDown = (chunk: Uint8Array) => {
      socket.send(chunk);
      sent += chunk.byteLength;
      unackedTotal += chunk.byteLength;
      byClient.unacked += chunk.byteLength;
      sinceMark += chunk.byteLength;
      if (sinceMark >= limits.seqEvery) {
        const mark = { nonce: nonce(), at: sent };
        marks.push(mark);
        socket.send(`seq ${mark.nonce}`);
        sinceMark = 0;
      }
      // A caller over its own budget loses its largest holder.
      if (byClient.unacked > limits.downstreamPerClient) {
        const mine = [...live].filter((c) => c.client === client);
        const largest = mine.reduce((a, b) =>
          b.unacked() > a.unacked() ||
            (b.unacked() === a.unacked() && b.ackedAt() < a.ackedAt())
            ? b
            : a
        );
        largest.end(
          CLOSE_ERRNO_BASE + ECONNRESET,
          "too much unacknowledged data",
        );
      }
      if (unackedTotal > limits.downstreamTotal) evictUnacked();
    };
    socket.addEventListener("close", () => end());
    socket.addEventListener("error", () => end());
    socket.addEventListener("message", (event) => {
      if (ended) return;
      if (typeof event.data === "string") {
        credit(event.data);
        return;
      }
      if (!(event.data instanceof ArrayBuffer) || writer === undefined) {
        end(CLOSE_ERRNO_BASE + ECONNRESET, "unexpected frame");
        return;
      }
      const bytes = new Uint8Array(event.data);
      if (!count(bytes.byteLength)) return;
      if (queued === 0) writingSince = now();
      queued += bytes.byteLength;
      byClient.queued += bytes.byteLength;
      queuedTotal += bytes.byteLength;
      if (
        queued > limits.upstreamQueueBytes ||
        byClient.queued > limits.upstreamQueuePerClient
      ) {
        end(
          CLOSE_ERRNO_BASE + ECONNRESET,
          "sending faster than the server takes it",
        );
        return;
      }
      // The isolate's budget: the heaviest caller goes, maybe not this one.
      if (queuedTotal > limits.upstreamQueueTotal) evictQueued();
      if (ended) return;
      alive();
      const w = writer;
      writes = writes.then(() => {
        // A server that takes nothing for writeStallMs ends the connection.
        if (ended) return;
        return Promise.race([
          w.write(bytes),
          new Promise<never>((_, reject) => {
            stall = setTimeout(
              () => reject(new Error("stalled")),
              limits.writeStallMs,
            );
          }),
        ]).finally(() => clearTimeout(stall));
      }).then(
        () => {
          if (ended) return;
          unqueue(bytes.byteLength);
          writingSince = queued === 0 ? Infinity : now();
        },
        (error) =>
          end(
            CLOSE_ERRNO_BASE +
              (error?.message === "stalled" ? ETIMEDOUT : ECONNRESET),
            "write failed",
          ),
      );
    });
    /** Until the page has acknowledged enough to fall within the window,
     * or the connection ends; a page that gives no credit for `idleMs` is
     * cut. */
    const waitForCredit = async () => {
      if (sent - acked <= limits.downstreamWindow) return;
      const stalled = setTimeout(
        () => end(CLOSE_ERRNO_BASE + ETIMEDOUT, "no acknowledgement"),
        limits.idleMs,
      );
      while (!ended && sent - acked > limits.downstreamWindow) {
        await new Promise<void>((resolve) => credited = resolve);
      }
      credited = undefined;
      clearTimeout(stalled);
    };
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
            sendDown(chunk);
            await waitForCredit();
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
    address: string | undefined,
  ): Promise<Response> => {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") ?? "";
    if (!platform.allowedOrigins.includes(origin)) {
      return new Response("origin not allowed\n", { status: 403 });
    }
    if (address === undefined || address === "") {
      return new Response("no client address\n", {
        status: 400,
        headers: cors(origin),
      });
    }
    const client = clientKey(address);
    if (request.method !== "GET") {
      return new Response("GET only\n", { status: 405, headers: cors(origin) });
    }
    if (url.pathname === "/token") {
      if (
        !mayIssue(client) || !(await platform.allowToken?.(client) ?? true)
      ) {
        return json(origin, { error: "too many tokens" }, 429);
      }
      const human = url.searchParams.get("turnstile") ?? "";
      if (human === "" || !await platform.verifyHuman(human, address)) {
        return json(origin, { error: "the Turnstile check failed" }, 403);
      }
      // Bound to the exact address; counted by the caller's key.
      // `ttl`, not only `expires`: the page judges freshness by its own
      // clock, which may be off.
      return json(origin, {
        ...await issueToken(platform.secret, address, now(), limits.tokenTtlMs),
        ttl: limits.tokenTtlMs / 1000,
      });
    }
    const token = await verifyToken(
      platform.secret,
      url.searchParams.get("token") ?? "",
      address,
      now(),
    );
    if (token === undefined) {
      return json(origin, { error: "no valid token" }, 401);
    }
    if (url.pathname === "/dns") {
      if (!mayAsk(token.id) || !mayClientAsk(client)) {
        return json(origin, { error: "too many questions" }, 429);
      }
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
      return tcp(request, url, token, client);
    }
    return new Response("not found\n", { status: 404, headers: cors(origin) });
  };

  return { handle, usage: { tokens, clients } };
}
