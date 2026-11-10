// A Chrome DevTools endpoint inside the in-tab sandbox, at the guest's
// 127.0.0.1:9222, for a Playwright (or any CDP client) running there:
//
//   chromium.connectOverCDP("http://127.0.0.1:9222")
//
// It answers `GET /json/version` itself and turns a WebSocket on
// `/devtools/browser/...` into whole CDP messages for the page, which hands
// them to the Yurt browser bridge extension (extension/, src/browser_bridge.ts):
// the extension drives tabs it opens in this browser. Like the pkg relay
// (src/pkg_relay.ts), it is the kernel's own host socket on the sandbox's
// loopback: nothing leaves the sandbox but these messages.
import { METHOD } from "@yurt/kernel-host-interface-js";
import {
  AF_INET,
  backoff,
  EAGAIN,
  fdRequest,
  MAX_HEAD_BYTES,
  MSG_DONTWAIT,
  MSG_NOSIGNAL,
  parseRequestHead,
  type RelayKernel,
  SOCK_NONBLOCK,
  SOCK_STREAM,
} from "./pkg_relay.ts";
import { acceptKey, encodeFrame, MessageReader, OPCODE } from "./ws_frames.ts";

export const CDP_PORT = 9222;
/** The one browser target the endpoint names (the extension is the
 *  browser); any `/devtools/browser/<id>` path reaches it. */
export const BROWSER_PATH = "/devtools/browser/yurt";
const MAX_CONNECTIONS = 4;
const ACCEPT_EVERY_MS = 100;

export type CdpBridgeHandlers = {
  /** A client opened a DevTools WebSocket as connection `conn`. */
  open(conn: number): void;
  /** A whole CDP message (JSON text) from connection `conn`. */
  message(conn: number, text: string): void;
  /** Connection `conn` is gone (either side closed it). */
  close(conn: number): void;
};

export type CdpBridge = {
  /** Send a CDP message (JSON text) to connection `conn`. */
  send(conn: number, text: string): void;
  /** Close connection `conn` (the extension went away, say). */
  close(conn: number): void;
  /** Close everything and stop listening. */
  stop(): void;
};

/** What `GET /json/version` answers; Playwright takes the WebSocket URL
 *  from it. */
export function versionJson(product: string): string {
  return JSON.stringify({
    Browser: product,
    "Protocol-Version": "1.3",
    "User-Agent": globalThis.navigator?.userAgent ?? "",
    webSocketDebuggerUrl: `ws://127.0.0.1:${CDP_PORT}${BROWSER_PATH}`,
  });
}

/** The reply head and body for a plain HTTP request on the endpoint, or
 *  undefined for a WebSocket upgrade the caller completes. */
export function httpReply(
  method: string,
  target: string,
  product: string,
): { status: number; type: string; body: string } | undefined {
  const path = target.split("?")[0].replace(/\/$/, "");
  if (method === "GET" && path === "/json/version") {
    return {
      status: 200,
      type: "application/json",
      body: versionJson(product),
    };
  }
  if (path.startsWith("/devtools/browser")) return undefined;
  return {
    status: 404,
    type: "text/plain",
    body: "this endpoint serves /json/version and /devtools/browser only\n",
  };
}

/** Listen on the guest's 127.0.0.1:{@link CDP_PORT} in `mk`'s sandbox. */
export function startCdpBridge(
  mk: RelayKernel,
  handlers: CdpBridgeHandlers,
  product = "Chrome (Yurt browser bridge)",
): CdpBridge {
  const call = (method: number, req: Uint8Array, cap = 0) => {
    const { rc, response } = mk.syscall(method, req, cap);
    return { rc: Number(rc), response };
  };
  const closeFd = (fd: number) => call(METHOD.SYS_SOCKET_CLOSE, fdRequest(fd));
  const open = new Uint8Array(8);
  open[0] = AF_INET;
  open[1] = SOCK_STREAM;
  new DataView(open.buffer).setUint32(4, SOCK_NONBLOCK, true);
  const listener = call(METHOD.SYS_SOCKET_OPEN, open).rc;
  if (listener < 0) throw new Error(`cdp bridge socket: rc=${listener}`);
  const bind = fdRequest(listener, 16);
  const addr = new DataView(bind.buffer, 4, 16);
  addr.setUint16(0, AF_INET, true);
  addr.setUint16(2, CDP_PORT, false);
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
      closeFd(listener);
      throw new Error(`cdp bridge ${what} 127.0.0.1:${CDP_PORT}: rc=${rc}`);
    }
  }

  let stopped = false;
  const chunkCap = Math.max(
    4096,
    Math.min(64 * 1024, (mk.scratchLen ?? 0) - 64),
  );
  /** Open WebSockets, by connection (the fd): their outgoing queue. */
  const sockets = new Map<number, { queue: Uint8Array[]; flushing: boolean }>();
  const fds = new Set<number>();

  const recv = (fd: number, cap: number) => {
    const req = fdRequest(fd, 4);
    new DataView(req.buffer).setUint32(4, MSG_DONTWAIT, true);
    return call(METHOD.SYS_SOCKET_RECV, req, cap);
  };
  const sendAll = async (fd: number, bytes: Uint8Array) => {
    const wait = backoff();
    let at = 0;
    while (at < bytes.byteLength) {
      if (stopped || !fds.has(fd)) throw new Error("closed");
      const chunk = bytes.subarray(at, at + chunkCap);
      const req = fdRequest(fd, 4 + chunk.byteLength);
      new DataView(req.buffer).setUint32(4, MSG_DONTWAIT | MSG_NOSIGNAL, true);
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
  const end = (fd: number) => {
    if (!fds.delete(fd)) return;
    closeFd(fd);
    if (sockets.delete(fd)) handlers.close(fd);
  };
  const flush = async (fd: number) => {
    const socket = sockets.get(fd);
    if (socket === undefined || socket.flushing) return;
    socket.flushing = true;
    try {
      while (socket.queue.length > 0) await sendAll(fd, socket.queue.shift()!);
    } catch {
      end(fd);
    } finally {
      socket.flushing = false;
    }
  };
  const enqueue = (fd: number, frame: Uint8Array) => {
    const socket = sockets.get(fd);
    if (socket === undefined) return;
    socket.queue.push(frame);
    void flush(fd);
  };

  const readHead = async (fd: number): Promise<string | undefined> => {
    const wait = backoff();
    const deadline = Date.now() + 10_000;
    let head = "";
    while (!stopped && Date.now() < deadline) {
      const { rc, response } = recv(fd, MAX_HEAD_BYTES - head.length + 1);
      if (rc === -EAGAIN) {
        await wait.wait();
        continue;
      }
      if (rc <= 0) return undefined;
      wait.progressed();
      head += String.fromCharCode(...response.subarray(0, rc));
      if (head.includes("\r\n\r\n")) {
        return head.slice(0, head.indexOf("\r\n\r\n"));
      }
      if (head.length > MAX_HEAD_BYTES) return undefined;
    }
    return undefined;
  };

  const serve = async (fd: number) => {
    try {
      const head = await readHead(fd);
      const request = head === undefined ? undefined : parseRequestHead(head);
      if (request === undefined) return end(fd);
      const plain = httpReply(request.method, request.target, product);
      if (plain !== undefined) {
        const body = new TextEncoder().encode(plain.body);
        await sendAll(
          fd,
          new TextEncoder().encode(
            `HTTP/1.1 ${plain.status} ${
              plain.status === 200 ? "OK" : "Not Found"
            }\r\n` +
              `Content-Type: ${plain.type}\r\nContent-Length: ${body.length}\r\n` +
              "Connection: close\r\n\r\n",
          ),
        );
        await sendAll(fd, body);
        return end(fd);
      }
      const key = request.headers.get("sec-websocket-key");
      if (
        key === undefined ||
        request.headers.get("upgrade")?.toLowerCase() !== "websocket"
      ) {
        return end(fd);
      }
      await sendAll(
        fd,
        new TextEncoder().encode(
          "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n" +
            `Connection: Upgrade\r\nSec-WebSocket-Accept: ${await acceptKey(
              key,
            )}\r\n\r\n`,
        ),
      );
      sockets.set(fd, { queue: [], flushing: false });
      handlers.open(fd);
      const reader = new MessageReader();
      const wait = backoff();
      while (!stopped && fds.has(fd)) {
        const { rc, response } = recv(fd, chunkCap);
        if (rc === -EAGAIN) {
          await wait.wait();
          continue;
        }
        if (rc <= 0) break;
        wait.progressed();
        const { messages, replies, closed } = reader.push(
          response.slice(0, rc),
        );
        for (const text of messages) handlers.message(fd, text);
        for (const reply of replies) enqueue(fd, reply);
        if (closed) {
          await flush(fd);
          break;
        }
      }
    } catch (error) {
      if (!stopped) {
        console.warn(
          `[cdp bridge] ${error instanceof Error ? error.message : error}`,
        );
      }
    } finally {
      end(fd);
    }
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const accept = () => {
    timer = undefined;
    if (stopped) return;
    for (;;) {
      const { rc } = call(METHOD.SYS_SOCKET_ACCEPT, fdRequest(listener, 4), 16);
      if (rc === -EAGAIN) break;
      if (rc < 0) {
        console.warn(`[cdp bridge] accept: rc=${rc}`);
        break;
      }
      if (fds.size >= MAX_CONNECTIONS) {
        closeFd(rc);
        continue;
      }
      fds.add(rc);
      void serve(rc);
    }
    timer = setTimeout(accept, ACCEPT_EVERY_MS);
  };
  accept();

  return {
    send(conn, text) {
      enqueue(conn, encodeFrame(OPCODE.text, new TextEncoder().encode(text)));
    },
    close(conn) {
      enqueue(conn, encodeFrame(OPCODE.close, new Uint8Array([0x03, 0xe8])));
      void flush(conn).then(() => end(conn));
    },
    stop() {
      if (stopped) return;
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      for (const fd of [...fds]) end(fd);
      closeFd(listener);
    },
  };
}
