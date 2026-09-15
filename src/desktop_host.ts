/**
 * The launcher's side of `yurt-desktop-host` (a private binary, pinned and
 * fetched like the kernel wasm; its contract is the sandbox repo's
 * docs/desktop-host-api.md): spawn it with the runtime, kernel and image
 * that travel in the bundle's `runtime/` directory, read the one line it
 * prints, and proxy the page's `/ws/*` sockets to it so the page stays on
 * its own origin.
 */
import { join } from "node:path";

export type DesktopHost = {
  /** `http://127.0.0.1:<port>/`, the host's own listener. */
  url: string;
  /** shell, iopub, stdin, control, hb, from the host's /status. */
  kernelPorts: [number, number, number, number, number];
  bootMs: number;
  stop: () => void;
};

/** The files the bundle carries beside dist/. */
export const RUNTIME_FILES = {
  host: "yurt-desktop-host",
  runtime: "yurt-runtime-wasmtime",
  kernelWasm: "yurt_kernel.wasm",
  image: "playground.yurtimg",
} as const;

export async function startDesktopHost(
  runtimeDir: string,
): Promise<DesktopHost> {
  const child = new Deno.Command(join(runtimeDir, RUNTIME_FILES.host), {
    args: [
      "--runtime",
      join(runtimeDir, RUNTIME_FILES.runtime),
      "--kernel-wasm",
      join(runtimeDir, RUNTIME_FILES.kernelWasm),
      "--image",
      join(runtimeDir, RUNTIME_FILES.image),
    ],
    stdin: "piped",
    stdout: "piped",
    stderr: "inherit",
  }).spawn();
  // The announce is the first and only stdout line.
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let url: string | undefined;
  while (url === undefined) {
    const { value, done } = await reader.read();
    if (done) {
      throw new Error("yurt-desktop-host exited before announcing its URL");
    }
    text += decoder.decode(value, { stream: true });
    const line = text.match(
      /^yurt-desktop-host: (http:\/\/127\.0\.0\.1:\d+\/)$/m,
    );
    if (line) url = line[1];
  }
  reader.cancel().catch(() => undefined);
  const status = await (await fetch(`${url}status`)).json();
  return {
    url,
    kernelPorts: status.kernelPorts,
    bootMs: status.bootMs,
    stop() {
      // Closing its stdin is how the host is told to stop (and tear the
      // sandbox down); it exits on its own.
      child.stdin.close();
    },
  };
}

/** Relay a WebSocket upgrade to the host's same path. */
export function proxyWebSocket(req: Request, host: DesktopHost): Response {
  const path = new URL(req.url).pathname;
  const upstreamUrl = `${host.url.replace(/^http/, "ws")}${
    path.replace(/^\//, "")
  }`;
  const { socket, response } = Deno.upgradeWebSocket(req);
  const upstream = new WebSocket(upstreamUrl);
  socket.binaryType = "arraybuffer";
  upstream.binaryType = "arraybuffer";
  const pending: Array<string | ArrayBuffer> = [];
  upstream.onopen = () => {
    for (const frame of pending) upstream.send(frame);
    pending.length = 0;
  };
  socket.onmessage = (event) => {
    if (upstream.readyState === WebSocket.OPEN) upstream.send(event.data);
    else if (upstream.readyState === WebSocket.CONNECTING) {
      pending.push(event.data);
    }
  };
  upstream.onmessage = (event) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(event.data);
  };
  socket.onclose = () => upstream.close();
  upstream.onclose = (event) => {
    if (socket.readyState === WebSocket.OPEN) {
      socket.close(
        event.code >= 1000 && event.code < 5000 ? event.code : 1011,
        event.reason,
      );
    }
  };
  socket.onerror = () => upstream.close();
  upstream.onerror = () => {
    if (socket.readyState === WebSocket.OPEN) {
      socket.close(1011, "host socket failed");
    }
  };
  return response;
}
