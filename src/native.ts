/**
 * The desktop app's transport: the sandbox runs on the native runtime in
 * `yurt-desktop-host` (a private sidecar the launcher spawns), and the page
 * reaches it over two WebSockets the launcher proxies on its own origin:
 * `/ws/tty` (the PTY) and `/ws/port/<n>` (bytes to a kernel port). See the
 * host's docs/desktop-host-api.md. Everything above this module — xterm,
 * the ipykernel launch through the shell, the ZMTP framing — is unchanged.
 */
import type { SandboxPortConn } from "@yurt/kernel-host-interface-js";
import type { PlaygroundEnv, PlaygroundSession } from "./boot.ts";
import { createSessionController } from "./session_controller.ts";

/** What the launcher serves at `/desktop.json`; absent on the hosted site. */
export type DesktopInfo = {
  native: true;
  /** shell, iopub, stdin, control, hb: the ports ipykernel is launched on. */
  kernelPorts: [number, number, number, number, number];
  bootMs: number;
};

/** The launcher's answer, or `undefined` on the hosted site. Absolute, so
 * the JupyterLite pages under /jupyter/ ask the same place; JSON only, so a
 * host that answers every unknown path with the home page and a 200
 * (Cloudflare Pages does) reads as "not the app"; never throws. */
export async function desktopInfo(
  fetchJson: (path: string) => Promise<Response> = (path) => fetch(path),
): Promise<DesktopInfo | undefined> {
  try {
    const response = await fetchJson("/desktop.json");
    if (!response.ok) return undefined;
    if (!(response.headers.get("content-type") ?? "").includes("json")) {
      return undefined;
    }
    const info = await response.json();
    return info?.native === true ? (info as DesktopInfo) : undefined;
  } catch {
    return undefined;
  }
}

function wsUrl(path: string): string {
  const url = new URL(path, self.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.href;
}

function openSocket(path: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl(path));
    ws.binaryType = "arraybuffer";
    ws.onopen = () => resolve(ws);
    ws.onerror = () => reject(new Error(`WebSocket ${path} failed to open`));
  });
}

/** A `SandboxPortConn` over `/ws/port/<port>`, dialed synchronously like the
 * in-tab one: the socket opens in the background and the first write or read
 * waits for it. Reads are served from the frames received so far, a short
 * read is success, and the host's close ends the stream with an empty read. */
function dialNativePort(port: number): SandboxPortConn {
  const ws = new WebSocket(wsUrl(`/ws/port/${port}`));
  ws.binaryType = "arraybuffer";
  const chunks: Uint8Array[] = [];
  let closed = false;
  let wake: (() => void) | undefined;
  const notify = () => {
    const w = wake;
    wake = undefined;
    w?.();
  };
  const opened = new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => {
      closed = true;
      notify();
      reject(new Error(`dialSandboxPort ${port}: WebSocket failed`));
    };
  });
  // A dial nobody awaits must not surface as an unhandled rejection.
  opened.catch(() => undefined);
  ws.onmessage = (event: MessageEvent) => {
    chunks.push(new Uint8Array(event.data as ArrayBuffer));
    notify();
  };
  ws.onclose = () => {
    closed = true;
    notify();
  };
  return {
    async write(bytes) {
      await opened;
      if (closed) throw new Error("dialSandboxPort: closed");
      ws.send(bytes);
    },
    async read(n) {
      await opened;
      while (chunks.length === 0 && !closed) {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
      if (chunks.length === 0) return new Uint8Array();
      const head = chunks[0];
      if (head.byteLength <= n) {
        chunks.shift();
        return head;
      }
      chunks[0] = head.subarray(n);
      return head.subarray(0, n);
    },
    close() {
      closed = true;
      ws.close();
      return Promise.resolve();
    },
  };
}

export async function bootNativePlayground(
  env: PlaygroundEnv,
): Promise<PlaygroundSession> {
  env.show("connecting to the sandbox");
  const ws = await openSocket("/ws/tty");
  const encoder = new TextEncoder();
  const outputHandlers = new Set<(bytes: Uint8Array) => void>();
  ws.onmessage = (event: MessageEvent) => {
    const bytes = new Uint8Array(event.data as ArrayBuffer);
    env.term.write(bytes);
    for (const handler of outputHandlers) handler(bytes);
  };
  const resize = (rows: number, cols: number) =>
    ws.send(JSON.stringify({ resize: { rows, cols } }));
  resize(env.term.rows, env.term.cols);
  const terminal = {
    write(bytes: Uint8Array) {
      ws.send(bytes);
      return Promise.resolve();
    },
    close() {
      ws.close();
    },
  };
  const controller = createSessionController({ pty: terminal });
  env.term.onData((data) => {
    if (controller.state !== "ready") return;
    void controller.current.pty.write(encoder.encode(data));
  });
  env.term.onResize(({ rows, cols }) => resize(rows, cols));
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    controller.current.pty.close();
  };
  ws.onclose = () => {
    if (!stopped) env.show("the sandbox went away");
    stop();
  };
  env.show("");
  return {
    stop,
    controller,
    terminal,
    dialSandboxPort: dialNativePort,
    onOutput(handler) {
      outputHandlers.add(handler);
      return () => outputHandlers.delete(handler);
    },
  };
}
