// deno-lint-ignore-file no-control-regex
// HTTP framing deliberately rejects ASCII control bytes.
export type GuestMethod = "GET" | "HEAD";
export type HeaderPairs = [string, string][];
export interface GuestConnection {
  write(bytes: Uint8Array): Promise<void>;
  read(size: number): Promise<Uint8Array>;
  close(): Promise<void>;
}
export interface GuestHttpReply {
  status: number;
  headers: HeaderPairs;
  body: ArrayBuffer;
}
export interface GuestHttpOptions {
  session: string;
  prefix: string;
  method: GuestMethod;
  path: string;
  port?: number;
  headers: HeaderPairs;
  signal: AbortSignal;
  timeoutMs?: number;
}
export class GuestHttpError extends Error {
  constructor(message: string, readonly status = 502) {
    super(message);
    this.name = "GuestHttpError";
  }
}
const HEADER_LIMIT = 64 * 1024;
const BODY_LIMIT = 16 * 1024 * 1024;
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const origin = (port = 8001) => `http://127.0.0.1:${port}`;
const HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const ALLOWED = new Set([
  "accept",
  "accept-language",
  "if-none-match",
  "if-modified-since",
]);
function fail(message: string): never {
  throw new GuestHttpError(message);
}
export function validateGuestPath(
  session: string,
  prefix: string,
  path: string,
  port = 8001,
): void {
  if (!UUID.test(session) || prefix !== `/apps/datasette/${session}/`) {
    fail("invalid session prefix");
  }
  if (
    !path.startsWith(prefix) || /[\x00-\x20\x7f\\#]/.test(path) ||
    /%2f|%5c/i.test(path.split("?")[0])
  ) {
    fail("invalid guest request path");
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(path.split("?")[0]);
  } catch {
    fail("invalid path encoding");
  }
  if (
    /[\x00-\x20\x7f\\]/.test(decoded) ||
    !new URL(decoded, origin(port)).pathname.startsWith(prefix)
  ) fail("guest path escapes session");
  if (!new URL(path, origin(port)).pathname.startsWith(prefix)) {
    fail("guest path escapes session");
  }
}
function redirect(
  location: string,
  path: string,
  prefix: string,
  port = 8001,
): string {
  if (/[\x00-\x20\x7f\\]/.test(location)) fail("invalid redirect location");
  let url: URL;
  try {
    url = new URL(location, origin(port) + path);
  } catch {
    fail("invalid redirect location");
  }
  if (
    url.origin !== origin(port) || url.username || url.password ||
    !url.pathname.startsWith(prefix)
  ) fail("redirect escapes session");
  let decoded: string;
  try {
    decoded = decodeURIComponent(url.pathname);
  } catch {
    fail("invalid redirect encoding");
  }
  if (
    decoded.includes("\\") ||
    !new URL(decoded, origin(port)).pathname.startsWith(prefix)
  ) fail("redirect escapes session");
  return url.pathname + url.search + url.hash;
}
class Reader {
  private bytes: Uint8Array = new Uint8Array();
  private at = 0;
  headerBytes = 0;
  constructor(private readonly read: () => Promise<Uint8Array>) {}
  async take(n: number): Promise<Uint8Array> {
    if (this.at === this.bytes.length) {
      this.bytes = await this.read();
      this.at = 0;
    }
    const end = Math.min(this.bytes.length, this.at + n);
    const out = this.bytes.subarray(this.at, end);
    this.at = end;
    return out;
  }
  async line(header = true): Promise<string> {
    const bytes: number[] = [];
    for (;;) {
      const byte = await this.take(1);
      if (!byte.length) fail("premature HTTP EOF");
      bytes.push(byte[0]);
      if (header && ++this.headerBytes > HEADER_LIMIT) {
        fail("HTTP headers exceed 64 KiB");
      }
      if (bytes.length > HEADER_LIMIT) fail("HTTP line exceeds 64 KiB");
      if (byte[0] === 10) {
        if (bytes.length < 2 || bytes[bytes.length - 2] !== 13) {
          fail("invalid HTTP line ending");
        }
        return bytes.slice(0, -2).map((b) => String.fromCharCode(b)).join("");
      }
    }
  }
  async exact(n: number): Promise<Uint8Array> {
    const out = new Uint8Array(n);
    let at = 0;
    while (at < n) {
      const part = await this.take(n - at);
      if (!part.length) fail("premature HTTP body EOF");
      out.set(part, at);
      at += part.length;
    }
    return out;
  }
}
function parseHeader(line: string): [string, string] {
  const colon = line.indexOf(":");
  const name = line.slice(0, colon);
  const value = line.slice(colon + 1).trim();
  if (
    colon <= 0 || !TOKEN.test(name) || /[\x00-\x08\x0a-\x1f\x7f]/.test(value)
  ) fail("malformed HTTP header");
  return [name.toLowerCase(), value];
}
function lengthOf(headers: HeaderPairs): number | undefined {
  const values = headers.filter(([k]) => k === "content-length").map(([, v]) =>
    v
  );
  if (values.length > 1) fail("duplicate Content-Length");
  if (!values.length) return undefined;
  if (!/^\d+$/.test(values[0])) fail("invalid Content-Length");
  const length = Number(values[0]);
  if (!Number.isSafeInteger(length)) fail("invalid Content-Length");
  return length;
}
export async function requestGuestHttp(
  dial: () => Promise<GuestConnection>,
  options: GuestHttpOptions,
): Promise<GuestHttpReply> {
  validateGuestPath(
    options.session,
    options.prefix,
    options.path,
    options.port,
  );
  if (options.method !== "GET" && options.method !== "HEAD") {
    throw new GuestHttpError("unsupported method", 405);
  }
  options.signal.throwIfAborted();
  const requestHeaders: HeaderPairs = [];
  for (const [key, value] of options.headers) {
    if (!TOKEN.test(key) || /[\x00-\x1f\x7f]/.test(value)) {
      fail("invalid request header");
    }
    if (ALLOWED.has(key.toLowerCase())) requestHeaders.push([key, value]);
  }
  const timeout = options.timeoutMs ?? 30_000;
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new GuestHttpError("guest HTTP deadline", 504);
  }
  let conn: GuestConnection | undefined;
  let closed = false;
  let finished = false;
  let cancellation: unknown;
  const cancelled = Promise.withResolvers<never>();
  const close = async () => {
    if (conn && !closed) {
      closed = true;
      await conn.close();
    }
  };
  const cancel = (error: unknown) => {
    if (finished || cancellation !== undefined) return;
    cancellation = error;
    cancelled.reject(error);
    void close().catch(() => {});
  };
  // Install the race consumer before an already-settled operation can reject.
  const race = <T>(operation: Promise<T>) =>
    Promise.race([operation, cancelled.promise]);
  const abort = () =>
    cancel(options.signal.reason ?? new DOMException("Aborted", "AbortError"));
  const timer = setTimeout(
    () => cancel(new GuestHttpError("guest HTTP deadline", 504)),
    Math.min(timeout, 30_000),
  );
  options.signal.addEventListener("abort", abort, { once: true });
  try {
    const opening = Promise.resolve().then(dial).then(async (c) => {
      conn = c;
      if (cancellation !== undefined) {
        await close().catch(() => {});
        throw cancellation;
      }
      return c;
    });
    await race(opening);
    if (!conn) fail("guest connection unavailable");
    const request =
      `${options.method} ${options.path} HTTP/1.1\r\nHost: 127.0.0.1:${
        options.port ?? 8001
      }\r\nConnection: close\r\nAccept-Encoding: identity\r\n` +
      requestHeaders.map(([k, v]) => `${k}: ${v}\r\n`).join("") + "\r\n";
    await race(conn.write(new TextEncoder().encode(request)));
    const reader = new Reader(() => race(conn!.read(8192)));
    let status = 0;
    let headers: HeaderPairs = [];
    for (let interim = 0;; interim++) {
      const line = await reader.line();
      const match = /^HTTP\/1\.[01] ([0-9]{3})(?: [\x20-\x7e\x80-\xff]*)?$/
        .exec(line);
      if (!match) fail("invalid HTTP status");
      status = Number(match[1]);
      if (status < 100 || status > 599 || status === 101) {
        fail("unsupported HTTP status");
      }
      headers = [];
      for (;;) {
        const line = await reader.line();
        if (!line) break;
        headers.push(parseHeader(line));
      }
      if (status >= 200) break;
      if (interim >= 8) fail("too many informational responses");
    }
    const length = lengthOf(headers);
    const transfers = headers.filter(([k]) => k === "transfer-encoding").map((
      [, v],
    ) => v);
    if (
      transfers.length &&
      (transfers.length !== 1 || transfers[0].toLowerCase() !== "chunked" ||
        length !== undefined)
    ) fail("unsupported or conflicting HTTP framing");
    for (const [k, v] of headers) {
      if (k === "set-cookie") fail("guest cookies unsupported");
      if (k === "content-encoding" && v.toLowerCase() !== "identity") {
        fail("guest content encoding unsupported");
      }
    }
    const bodyless = options.method === "HEAD" || status === 204 ||
      status === 304;
    const chunks: Uint8Array[] = [];
    let total = 0;
    const append = (bytes: Uint8Array) => {
      total += bytes.length;
      if (total > BODY_LIMIT) fail("HTTP body exceeds 16 MiB");
      chunks.push(bytes);
    };
    if (!bodyless) {
      if (length !== undefined) {
        if (length > BODY_LIMIT) fail("HTTP body exceeds 16 MiB");
        append(await reader.exact(length));
      } else if (transfers.length) {
        for (;;) {
          const line = await reader.line(false);
          if (!/^[0-9a-fA-F]+(?:;[\x20-\x7e]*)?$/.test(line)) {
            fail("invalid HTTP chunk");
          }
          const size = parseInt(line.split(";")[0], 16);
          if (!Number.isSafeInteger(size) || size > BODY_LIMIT - total) {
            fail("HTTP body exceeds 16 MiB");
          }
          if (size === 0) {
            for (;;) {
              const trailer = await reader.line();
              if (!trailer) break;
              const [k] = parseHeader(trailer);
              if (
                k === "content-length" || k === "transfer-encoding" ||
                k === "set-cookie"
              ) fail("invalid framing trailer");
            }
            break;
          }
          append(await reader.exact(size));
          const end = await reader.exact(2);
          if (end[0] !== 13 || end[1] !== 10) fail("invalid chunk ending");
        }
      } else {for (;;) {
          const part = await reader.take(8192);
          if (!part.length) break;
          append(part.slice());
        }}
    }
    const body = new Uint8Array(total);
    let at = 0;
    for (const chunk of chunks) {
      body.set(chunk, at);
      at += chunk.length;
    }
    const removed = new Set(HOP);
    for (const [k, v] of headers) {
      if (k === "connection") {
        for (const name of v.split(",")) {
          if (!TOKEN.test(name.trim())) fail("invalid Connection header");
          removed.add(name.trim().toLowerCase());
        }
      }
    }
    headers = headers.filter(([k]) =>
      !removed.has(k) && k !== "content-length"
    );
    headers = headers.map((
      [k, v],
    ) => [
      k,
      k === "location"
        ? redirect(v, options.path, options.prefix, options.port)
        : v,
    ]);
    if (!bodyless) headers.push(["content-length", String(total)]);
    else if (status !== 204 && length !== undefined) {
      headers.push(["content-length", String(length)]);
    }
    return { status, headers, body: body.buffer };
  } catch (error) {
    if (cancellation !== undefined) throw cancellation;
    if (error instanceof GuestHttpError || error instanceof DOMException) {
      throw error;
    }
    throw new GuestHttpError(
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    finished = true;
    clearTimeout(timer);
    options.signal.removeEventListener("abort", abort);
    await close().catch(() => {});
  }
}
