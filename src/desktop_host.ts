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
  /** From the announce line; every request to the host carries it as
   * `?token=`. The page never sees it: that is what keeps another page on
   * this machine from reaching the sandbox's shell through the host. */
  token: string;
  /** shell, iopub, stdin, control, hb, from the host's /status. */
  kernelPorts: [number, number, number, number, number];
  bootMs: number;
  /** One request to the host's HTTP routes (`sessions`, `fs/content`,
   * ...), the token added: what the launcher's `/api/*` is built on
   * (src/desktop_api.ts). */
  request: HostRequest;
  /** Whether this host has the session and file routes (desktop-host
   * v0.1.3+); without them `/api/*` says so instead of failing each
   * command. */
  sessions: boolean;
  stop: () => void;
};

/** Does the host answer `/sessions/{id}` as the API expects? An older
 * host 404s with a plain body; the routes' 404 is JSON that names the
 * session. */
export async function probeSessions(request: HostRequest): Promise<boolean> {
  try {
    const response = await request("sessions/probe");
    const text = await response.text();
    return response.status === 404 && text.includes("no session probe");
  } catch {
    return false;
  }
}

export type HostRequest = (
  path: string,
  init?: RequestInit,
) => Promise<Response>;

/** `path` under `url` with `?token=` added (after a query the path has). */
export function hostRequest(url: string, token: string): HostRequest {
  return (path, init) => {
    const target = new URL(path, url);
    target.searchParams.set("token", token);
    return fetch(target, init);
  };
}

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
    // The host's stderr is the app's status window; the runtime's info
    // lines are not for the user. Warnings still show.
    stderr: "inherit",
    env: { RUST_LOG: "warn" },
  }).spawn();
  // The announce is the first and only stdout line: `URL TOKEN`.
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let announce: RegExpMatchArray | null = null;
  while (announce === null) {
    const { value, done } = await reader.read();
    if (done) {
      throw new Error("yurt-desktop-host exited before announcing its URL");
    }
    text += decoder.decode(value, { stream: true });
    announce = text.match(
      /^yurt-desktop-host: (http:\/\/127\.0\.0\.1:\d+\/) ([0-9a-f]+)$/m,
    );
  }
  reader.cancel().catch(() => undefined);
  const [, url, token] = announce;
  const request = hostRequest(url, token);
  const status = await (await request("status")).json();
  return {
    url,
    token,
    kernelPorts: status.kernelPorts,
    bootMs: status.bootMs,
    request,
    sessions: await probeSessions(request),
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
  }?token=${host.token}`;
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
