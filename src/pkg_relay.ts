/**
 * The package relay: how the guest's own `pkg`, typed into the terminal,
 * reaches YurtOS/yurt-packages from a tab whose sandbox has no network.
 *
 * The page listens on the sandbox's loopback, at {@link PKG_RELAY_URL}, as
 * the kernel's own host process, and the boot points the image's
 * `trusted-repos.toml` there ({@link relayTrustedRepos}). Each request is a
 * `GET` of one file under {@link PACKAGE_REPO_URL}, which the page fetches
 * with the browser's `fetch`, under its CSP, and hands back. Nothing else
 * is fetched: no other method, origin or path. `pkg` verifies every byte
 * as it does on the desktop (the index and archive signatures, the sha256
 * and size of every file), so the relay is only a transport: it can
 * withhold a file, never make `pkg` accept one the repository did not sign.
 *
 * Spec: docs/superpowers/specs/2026-10-31-terminal-pkg-in-the-browser-design.md
 */
import { METHOD } from "@yurt/kernel-host-interface-js";
import {
  checkRelative,
  INSTALL_MAX_BYTES,
  METADATA_MAX_BYTES,
  PACKAGE_REPO_URL,
  PKG_RELAY_PORT,
  sha256Hex,
  TABLET_MAX_BYTES,
} from "./packages.ts";

const AF_INET = 2;
const SOCK_STREAM = 1;
const SOCK_NONBLOCK = 0x800;
const MSG_DONTWAIT = 0x40;
const MSG_NOSIGNAL = 0x4000;
const EAGAIN = 11;

/** What the relay needs of the kernel: calls as its own host process. */
export type RelayKernel = {
  syscall(
    methodId: number,
    request: Uint8Array,
    responseCap: number,
  ): { rc: bigint; response: Uint8Array };
  scratchLen?: number;
};

export type RelayFetch = (url: string, init: RequestInit) => Promise<Response>;

export type RelayOptions = {
  /** A tablet's cap per response ({@link TABLET_MAX_BYTES}, #200). */
  tablet: boolean;
  fetch?: RelayFetch;
  /** Bytes of `path` forwarded so far, of `total` when it is known. */
  onFetch?: (path: string, received: number, total?: number) => void;
  /** How long a fetch may go without a byte. */
  stallMs?: number;
};

/** {@link relayReply}'s options: the relay's own, and its end. */
type ReplyOptions = RelayOptions & {
  /** Aborts every fetch at once: the relay has stopped. */
  stopped?: AbortSignal;
};

/** One request's head, as the relay reads it. */
export type RelayRequest = {
  method: string;
  target: string;
  headers: Map<string, string>;
};

/** A reply: a whole body, or an archive streamed under its length. */
export type RelayReply =
  | { status: number; headers: [string, string][]; body: Uint8Array }
  | {
    status: 200;
    headers: [string, string][];
    length: number;
    chunks: AsyncIterable<Uint8Array>;
    /** Stop the download, for a reply that is never sent whole. */
    cancel: () => void;
  };

/** Longest request head the relay reads. */
export const MAX_HEAD_BYTES = 8 * 1024;
/** Longest request path. */
export const MAX_PATH_BYTES = 512;
/** Connections open at once; pkg opens up to 8. */
export const MAX_CONNECTIONS = 16;
const HEAD_DEADLINE_MS = 10_000;
const STALL_MS = 30_000;
const ACCEPT_EVERY_MS = 100;
const BACKOFF_MIN_MS = 1;
const BACKOFF_MAX_MS = 50;

/** The two files pkg asks for conditionally (yurt-pkg update.rs): they get
 * an ETag from the relay, which the browser cannot pass on from GitHub. */
const CONDITIONAL = new Set(["index.json", "index.json.bundle"]);

/** The request head (`GET /path HTTP/1.1` and its header lines), or
 * `undefined` when it is not one. */
export function parseRequestHead(head: string): RelayRequest | undefined {
  const [requestLine, ...lines] = head.split("\r\n");
  const match = /^([A-Z]+) (\S+) HTTP\/1\.[01]$/.exec(requestLine);
  if (match === null) return undefined;
  const headers = new Map<string, string>();
  for (const line of lines) {
    if (line === "") continue;
    const colon = line.indexOf(":");
    if (colon <= 0) return undefined;
    headers.set(
      line.slice(0, colon).trim().toLowerCase(),
      line.slice(colon + 1).trim(),
    );
  }
  return { method: match[1], target: match[2], headers };
}

function text(status: number, message: string): RelayReply {
  return {
    status,
    headers: [["Content-Type", "text/plain; charset=utf-8"]],
    body: new TextEncoder().encode(`${message}\n`),
  };
}

/** The upstream URL for a request target, or why there is none. */
export function upstreamUrl(target: string): string | { refused: string } {
  if (!target.startsWith("/")) return { refused: "not an origin-form path" };
  const path = target.slice(1);
  if (new TextEncoder().encode(path).byteLength > MAX_PATH_BYTES) {
    return { refused: "path too long" };
  }
  try {
    checkRelative(path, "relay");
  } catch {
    return { refused: `unsupported path ${JSON.stringify(path)}` };
  }
  const url = new URL(path, PACKAGE_REPO_URL).href;
  if (!url.startsWith(PACKAGE_REPO_URL)) {
    return { refused: `outside ${PACKAGE_REPO_URL}` };
  }
  return url;
}

/** A fetch whose body may not stall: `signal` aborts once `stallMs` pass
 * with no byte (`alive` puts that off), or once `stopped` aborts, which
 * also ends the stall timer. */
function stallGuard(stallMs: number, stopped?: AbortSignal) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const done = () => clearTimeout(timer);
  const alive = () => {
    clearTimeout(timer);
    if (controller.signal.aborted) return;
    timer = setTimeout(
      () => controller.abort(new Error(`no data for ${stallMs} ms`)),
      stallMs,
    );
  };
  const stop = () => {
    done();
    controller.abort(new Error("the relay stopped"));
  };
  if (stopped?.aborted) stop();
  else stopped?.addEventListener("abort", stop, { once: true });
  alive();
  return { signal: controller.signal, alive, done };
}

/**
 * The reply to one request. Every refusal and failure is a status, never
 * a throw. Only a streamed archive can still fail once its header is out:
 * its `chunks` then throw, and the connection is closed short.
 */
export async function relayReply(
  request: RelayRequest,
  options: ReplyOptions,
): Promise<RelayReply> {
  if (request.method !== "GET") return text(405, "the relay only GETs");
  const length = request.headers.get("content-length");
  if (
    (length !== undefined && length !== "0") ||
    request.headers.has("transfer-encoding")
  ) {
    return text(400, "a GET has no body");
  }
  const url = upstreamUrl(request.target);
  if (typeof url !== "string") return text(403, url.refused);
  const path = request.target.slice(1);
  const cap = options.tablet ? TABLET_MAX_BYTES : INSTALL_MAX_BYTES;
  const capName = options.tablet ? "the tablet limit" : "the install limit";
  const guard = stallGuard(options.stallMs ?? STALL_MS, options.stopped);
  let response: Response;
  try {
    // None of the guest's headers: a CORS simple request (GitHub refuses
    // the preflight a header such as If-None-Match would need).
    response = await (options.fetch ?? fetch)(url, {
      method: "GET",
      cache: "no-cache",
      redirect: "error",
      credentials: "omit",
      signal: guard.signal,
    });
  } catch (error) {
    guard.done();
    return text(502, `fetch ${url} failed: ${message(error)}`);
  }
  if (!response.ok) {
    guard.done();
    await response.body?.cancel();
    return text(
      response.status === 404 ? 404 : 502,
      `${url}: HTTP ${response.status}`,
    );
  }
  const reader = response.body!.getReader();
  const upstreamLength = Number(response.headers.get("content-length"));
  // Archives stream; GitHub serves them as they are. Everything else it
  // gzips, so the Content-Length the browser exposes is not the length of
  // the bytes fetch() hands over: those are read whole, and counted.
  if (path.endsWith(".yurtpkg")) {
    // GitHub always says how long an archive is; one that does not is not
    // held whole in the page instead.
    if (!Number.isSafeInteger(upstreamLength) || upstreamLength <= 0) {
      guard.done();
      await reader.cancel();
      return text(502, `${url}: no Content-Length for an archive`);
    }
    if (upstreamLength > cap) {
      guard.done();
      await reader.cancel();
      return text(502, `${url}: ${upstreamLength} bytes is over ${capName}`);
    }
    return {
      status: 200,
      headers: [["Content-Type", "application/octet-stream"]],
      length: upstreamLength,
      chunks: streamExactly(
        reader,
        upstreamLength,
        guard,
        (received) => options.onFetch?.(path, received, upstreamLength),
      ),
      cancel: () => {
        guard.done();
        reader.cancel().catch(() => {});
      },
    };
  }
  let body: Uint8Array;
  try {
    body = await readAll(
      reader,
      METADATA_MAX_BYTES,
      guard,
      (received) => options.onFetch?.(path, received),
    );
  } catch (error) {
    return text(502, `${url}: ${message(error)}`);
  } finally {
    guard.done();
  }
  if (!CONDITIONAL.has(path)) {
    return { status: 200, headers: [], body };
  }
  // pkg's rollback check refuses an index no newer than its cache, so a
  // repeated `pkg update` must get the 304 GitHub would give it: the relay
  // is the origin of this validator, the body's own hash.
  const etag = `"sha256-${await sha256Hex(body)}"`;
  if (request.headers.get("if-none-match") === etag) {
    return { status: 304, headers: [["ETag", etag]], body: new Uint8Array() };
  }
  return { status: 200, headers: [["ETag", etag]], body };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readAll(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  limit: number,
  guard: { alive: () => void },
  onBytes: (received: number) => void,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    guard.alive();
    received += value.byteLength;
    if (received > limit) {
      await reader.cancel();
      throw new Error(`larger than ${limit} bytes`);
    }
    chunks.push(value);
    onBytes(received);
  }
  const out = new Uint8Array(received);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

/** The body, which must be exactly `length` bytes: a body that runs past
 * it or ends short throws, so the connection closes before pkg can take a
 * wrong body for a whole one. */
async function* streamExactly(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  length: number,
  guard: { alive: () => void; done: () => void },
  onBytes: (received: number) => void,
): AsyncGenerator<Uint8Array> {
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      guard.alive();
      received += value.byteLength;
      if (received > length) {
        throw new Error(`body runs past its ${length} bytes`);
      }
      onBytes(received);
      yield value;
    }
    if (received !== length) {
      throw new Error(`body ended at ${received} of ${length} bytes`);
    }
  } finally {
    guard.done();
    // A consumer that stopped early (a closed connection) or a failure
    // here: the download stops too.
    if (received !== length) await reader.cancel().catch(() => {});
  }
}

const REASONS: Record<number, string> = {
  200: "OK",
  304: "Not Modified",
  400: "Bad Request",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  502: "Bad Gateway",
};

/** The status line and headers of a reply. */
export function replyHead(reply: RelayReply): Uint8Array {
  const length = "body" in reply ? reply.body.byteLength : reply.length;
  const lines = [
    `HTTP/1.1 ${reply.status} ${REASONS[reply.status] ?? "Error"}`,
    `Content-Length: ${length}`,
    "Connection: close",
    ...reply.headers.map(([name, value]) => `${name}: ${value}`),
    "",
    "",
  ];
  return new TextEncoder().encode(lines.join("\r\n"));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fdRequest(fd: number, extra = 0): Uint8Array {
  const req = new Uint8Array(4 + extra);
  new DataView(req.buffer).setUint32(0, fd >>> 0, true);
  return req;
}

/** A backoff for I/O that would block: 1 ms doubling to 50 ms, back to
 * 1 ms after any progress. */
function backoff() {
  let delay = BACKOFF_MIN_MS;
  return {
    wait: async () => {
      await sleep(delay);
      delay = Math.min(delay * 2, BACKOFF_MAX_MS);
    },
    progressed: () => {
      delay = BACKOFF_MIN_MS;
    },
  };
}

export type PkgRelay = {
  /** Close every connection and the listener; nothing runs after it. */
  stop(): void;
};

/**
 * Listen on `127.0.0.1:`{@link PKG_RELAY_PORT} in `mk`'s sandbox and serve
 * the guest's requests, one per connection. Throws when the port cannot be
 * had: the boot runs this before any guest process exists.
 */
export function startPkgRelay(
  mk: RelayKernel,
  options: RelayOptions,
): PkgRelay {
  const call = (method: number, req: Uint8Array, cap = 0) => {
    const { rc, response } = mk.syscall(method, req, cap);
    return { rc: Number(rc), response };
  };
  const close = (fd: number) => call(METHOD.SYS_SOCKET_CLOSE, fdRequest(fd));

  const open = new Uint8Array(8);
  open[0] = AF_INET;
  open[1] = SOCK_STREAM;
  new DataView(open.buffer).setUint32(4, SOCK_NONBLOCK, true);
  const listener = call(METHOD.SYS_SOCKET_OPEN, open).rc;
  if (listener < 0) throw new Error(`pkg relay socket: rc=${listener}`);
  const bind = fdRequest(listener, 16);
  const addr = new DataView(bind.buffer, 4, 16);
  addr.setUint16(0, AF_INET, true);
  addr.setUint16(2, PKG_RELAY_PORT, false);
  bind.set([127, 0, 0, 1], 8);
  const listen = fdRequest(listener, 4);
  new DataView(listen.buffer).setUint32(4, 16, true);
  for (
    const [what, method, req] of [
      ["bind", METHOD.SYS_SOCKET_BIND, bind],
      ["listen", METHOD.SYS_SOCKET_LISTEN, listen],
    ] as const
  ) {
    const { rc } = call(method, req);
    if (rc !== 0) {
      close(listener);
      throw new Error(
        `pkg relay ${what} 127.0.0.1:${PKG_RELAY_PORT}: rc=${rc}`,
      );
    }
  }

  let stopped = false;
  /** Every fetch in flight ends with the relay. */
  const ended = new AbortController();
  const connections = new Set<number>();
  const chunkCap = Math.max(
    4096,
    Math.min(64 * 1024, (mk.scratchLen ?? 0) - 64),
  );
  // Accepted sockets block (they do not inherit the listener's
  // O_NONBLOCK), and a blocking call would park the kernel's own host
  // thread; a send to a gone peer would also signal it. (recv takes no
  // MSG_NOSIGNAL: EOPNOTSUPP.)
  const recvFlags = MSG_DONTWAIT;
  const sendFlags = MSG_DONTWAIT | MSG_NOSIGNAL;

  const readHead = async (fd: number): Promise<string | undefined> => {
    const deadline = Date.now() + HEAD_DEADLINE_MS;
    const wait = backoff();
    let head = "";
    const req = fdRequest(fd, 4);
    new DataView(req.buffer).setUint32(4, recvFlags, true);
    while (!stopped && Date.now() < deadline) {
      const { rc, response } = call(
        METHOD.SYS_SOCKET_RECV,
        req,
        MAX_HEAD_BYTES - head.length + 1,
      );
      if (rc === -EAGAIN) {
        await wait.wait();
        continue;
      }
      if (rc <= 0) return undefined;
      wait.progressed();
      // latin1: a head is ASCII, and this keeps one char per byte.
      head += String.fromCharCode(...response.subarray(0, rc));
      const end = head.indexOf("\r\n\r\n");
      if (end >= 0) return head.slice(0, end);
      if (head.length > MAX_HEAD_BYTES) return undefined;
    }
    return undefined;
  };

  const send = async (fd: number, bytes: Uint8Array): Promise<void> => {
    const wait = backoff();
    let at = 0;
    while (at < bytes.byteLength) {
      if (stopped) throw new Error("relay stopped");
      const chunk = bytes.subarray(at, at + chunkCap);
      const req = fdRequest(fd, 4 + chunk.byteLength);
      new DataView(req.buffer).setUint32(4, sendFlags, true);
      req.set(chunk, 8);
      const { rc } = call(METHOD.SYS_SOCKET_SEND, req);
      if (rc === -EAGAIN) {
        await wait.wait();
        continue;
      }
      if (rc <= 0) throw new Error(`send: rc=${rc}`);
      wait.progressed();
      at += rc;
    }
  };

  const serve = async (fd: number) => {
    let reply: RelayReply | undefined;
    try {
      const head = await readHead(fd);
      if (head === undefined) return;
      const request = parseRequestHead(head);
      reply = request === undefined
        ? text(400, "not an HTTP/1.1 request")
        : await relayReply(request, { ...options, stopped: ended.signal });
      await send(fd, replyHead(reply));
      if ("body" in reply) {
        await send(fd, reply.body);
      } else {
        for await (const chunk of reply.chunks) await send(fd, chunk);
      }
      reply = undefined;
    } catch (error) {
      // The guest went away, or an archive failed past its header: close
      // short, so pkg never takes a cut body for a whole one.
      if (!stopped) console.warn(`[pkg relay] ${message(error)}`);
    } finally {
      if (reply !== undefined && "cancel" in reply) reply.cancel();
      if (connections.delete(fd)) close(fd);
    }
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const accept = () => {
    timer = undefined;
    if (stopped) return;
    try {
      acceptAll();
    } catch (error) {
      // A kernel that trapped or went away: pkg's connects then fail at
      // once rather than wait on a listener nothing serves.
      console.warn(`[pkg relay] stopped: ${message(error)}`);
      stop();
      return;
    }
    timer = setTimeout(accept, ACCEPT_EVERY_MS);
  };
  const acceptAll = () => {
    for (;;) {
      const { rc } = call(METHOD.SYS_SOCKET_ACCEPT, fdRequest(listener, 4), 16);
      if (rc === -EAGAIN) break;
      if (rc < 0) {
        console.warn(`[pkg relay] accept: rc=${rc}`);
        break;
      }
      if (connections.size >= MAX_CONNECTIONS) {
        close(rc);
        continue;
      }
      connections.add(rc);
      void serve(rc);
    }
  };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    ended.abort();
    const fds = [...connections, listener];
    connections.clear();
    for (const fd of fds) {
      try {
        close(fd);
      } catch {
        // The kernel is already gone.
      }
    }
  };
  accept();
  return { stop };
}
