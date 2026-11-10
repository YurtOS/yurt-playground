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
  backoff,
  EAGAIN,
  fdRequest,
  guestSocketIo,
  listenOnGuestLoopback,
  parseRequestHead,
  type RelayKernel,
} from "./pkg_relay.ts";
import { acceptKey, encodeFrame, MessageReader, OPCODE } from "./ws_frames.ts";

export const CDP_PORT = 9222;
/** The one browser target the endpoint names (the extension is the
 *  browser); any `/devtools/browser/<id>` path reaches it. */
export const BROWSER_PATH = "/devtools/browser/yurt";
const MAX_CONNECTIONS = 4;
/** How long a closing connection may take to drain its queue. */
const CLOSE_DEADLINE_MS = 5_000;
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
  const listener = listenOnGuestLoopback(mk, CDP_PORT, "cdp bridge");

  let stopped = false;
  /** Every accepted socket, by fd. */
  const fds = new Set<number>();
  /** Open WebSockets by connection id: never reused, unlike an fd, so a
   *  late message for a gone connection reaches nothing. */
  type Socket = {
    fd: number;
    queue: Uint8Array[];
    flushing: boolean;
    /** Close once the queue is sent. */
    closing: boolean;
  };
  const sockets = new Map<number, Socket>();
  let nextConn = 1;

  const io = guestSocketIo(mk, (fd) => !stopped && fds.has(fd));
  const recv = io.recv;
  const sendAll = io.send;
  /** Close `fd` now, and say so for its connection. */
  const end = (fd: number, conn?: number) => {
    if (conn !== undefined) {
      // Ended already: its fd number may belong to a newer connection.
      if (sockets.get(conn)?.fd !== fd) return;
      sockets.delete(conn);
      handlers.close(conn);
    }
    if (fds.delete(fd)) {
      try {
        closeFd(fd);
      } catch {
        // the kernel is gone, and the socket with it
      }
    }
  };
  const flush = async (conn: number) => {
    const socket = sockets.get(conn);
    if (socket === undefined || socket.flushing) return;
    socket.flushing = true;
    try {
      // Its own liveness, not the fd's: a closed fd's number is reused.
      const open = () => !stopped && sockets.get(conn) === socket;
      while (socket.queue.length > 0) {
        await sendAll(socket.fd, socket.queue.shift()!, open);
      }
    } catch {
      socket.queue = [];
      socket.closing = true;
    } finally {
      socket.flushing = false;
    }
    if (socket.closing) end(socket.fd, conn);
  };
  const enqueue = (conn: number, frame: Uint8Array) => {
    const socket = sockets.get(conn);
    if (socket === undefined || socket.closing) return;
    socket.queue.push(frame);
    void flush(conn);
  };
  /** Close `conn` after what is queued, with `frame` last; a peer that
   *  will not take it within {@link CLOSE_DEADLINE_MS} is cut off. */
  const finish = (conn: number, frame?: Uint8Array) => {
    const socket = sockets.get(conn);
    if (socket === undefined || socket.closing) return;
    if (frame !== undefined) socket.queue.push(frame);
    socket.closing = true;
    setTimeout(() => end(socket.fd, conn), CLOSE_DEADLINE_MS);
    void flush(conn);
  };

  /** The request head, and the bytes after it in the same reads (a client
   *  may send its first frame with the upgrade). */
  const readHead = io.readHead;

  const serve = async (fd: number) => {
    let conn: number | undefined;
    try {
      const read = await readHead(fd);
      const request = read === undefined
        ? undefined
        : parseRequestHead(read.head);
      if (read === undefined || request === undefined) return;
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
        return;
      }
      const key = request.headers.get("sec-websocket-key");
      if (
        key === undefined ||
        request.headers.get("upgrade")?.toLowerCase() !== "websocket"
      ) {
        return;
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
      conn = nextConn++;
      const socket: Socket = { fd, queue: [], flushing: false, closing: false };
      sockets.set(conn, socket);
      handlers.open(conn);
      const reader = new MessageReader();
      const take = (bytes: Uint8Array) => {
        const { messages, replies, closed } = reader.push(bytes);
        for (const text of messages) handlers.message(conn!, text);
        for (const reply of replies.slice(0, closed ? -1 : undefined)) {
          enqueue(conn!, reply);
        }
        if (closed) finish(conn!, replies.at(-1));
        return closed;
      };
      if (read.rest.length > 0 && take(read.rest)) return;
      // Interactive: a script's next command after a pause is seen within
      // 5 ms, not the relay's 50.
      const wait = backoff(5);
      while (!stopped && !socket.closing) {
        const { rc, response } = recv(fd, io.chunkCap);
        if (rc === -EAGAIN) {
          await wait.wait();
          continue;
        }
        if (rc <= 0) break;
        wait.progressed();
        if (take(response.slice(0, rc))) return;
      }
      // The peer went away, or the page closed it (finish ends it).
      if (!socket.closing) end(fd, conn);
    } catch (error) {
      if (!stopped) {
        console.warn(
          `[cdp bridge] ${error instanceof Error ? error.message : error}`,
        );
      }
      if (conn !== undefined) end(fd, conn);
    } finally {
      // A plain request, a refused one, or a WebSocket that is gone.
      if (conn === undefined || !sockets.has(conn)) end(fd, conn);
    }
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const accept = () => {
    timer = undefined;
    if (stopped) return;
    try {
      acceptAll();
    } catch (error) {
      // A kernel that trapped or went away: stop, as the pkg relay does.
      console.warn(
        `[cdp bridge] stopped: ${
          error instanceof Error ? error.message : error
        }`,
      );
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
  };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
    for (const [conn, socket] of [...sockets]) end(socket.fd, conn);
    for (const fd of [...fds]) end(fd);
    try {
      closeFd(listener);
    } catch {
      // the kernel is gone, and the listener with it
    }
  };
  accept();

  return {
    send(conn, text) {
      enqueue(conn, encodeFrame(OPCODE.text, new TextEncoder().encode(text)));
    },
    close(conn) {
      finish(conn, encodeFrame(OPCODE.close, new Uint8Array([0x03, 0xe8])));
    },
    stop,
  };
}
