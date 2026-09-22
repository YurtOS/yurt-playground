/**
 * The desktop app's transport: the sandbox runs on the native runtime in
 * `yurt-desktop-host` (a private sidecar the launcher spawns), and the page
 * reaches it over two WebSockets the launcher proxies on its own origin:
 * `/ws/tty` (the PTY) and `/ws/port/<n>` (bytes to a kernel port). See the
 * host's docs/desktop-host-api.md. Everything above this module — xterm,
 * the ipykernel launch through the shell, the ZMTP framing — is unchanged.
 */
import type { SandboxPortConn } from "@yurt/kernel-host-interface-js";
import {
  outputFanout,
  type PlaygroundEnv,
  type PlaygroundSession,
} from "./boot.ts";
import type { YurtTransport } from "./agent_api.ts";
import type { RawResult, Result } from "./executions.ts";
import { createSessionController } from "./session_controller.ts";

/** What the launcher serves at `/desktop.json`; absent on the hosted site. */
export type DesktopInfo = {
  native: true;
  /** shell, iopub, stdin, control, hb: the ports ipykernel is launched on. */
  kernelPorts: [number, number, number, number, number];
  bootMs: number;
  /** Opens the launcher's `/api/*` (src/desktop_api.ts) to this page's
   * `window.yurt`; served to this origin only, never in a URL. Absent
   * from a launcher older than the API. */
  apiToken?: string;
};

/** `window.yurt`'s transport on the desktop page: the launcher's
 * `/api/*`, where the registry lives (a `curl` on the machine sees the
 * same executions). Results are JSON, text on the wire; `waitRaw`
 * encodes them, and `files` moves bytes as bytes. */
export function nativeYurtTransport(
  token: string,
  fetchApi: typeof fetch = (input, init) => fetch(input, init),
): YurtTransport {
  const call = async (
    path: string,
    init: RequestInit = {},
  ): Promise<Response> => {
    const response = await fetchApi(`/api${path}`, {
      ...init,
      headers: { ...init.headers, authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      let message = `${init.method ?? "GET"} /api${path}: ${response.status}`;
      try {
        const body = await response.json();
        if (typeof body.error === "string") message = body.error;
      } catch {
        // not JSON: the status is the message
      }
      throw new Error(message);
    }
    return response;
  };
  const json = (path: string, init?: RequestInit) =>
    call(path, init).then((r) => r.json());
  const post = (path: string, body: unknown, method = "POST") =>
    json(path, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const encoder = new TextEncoder();
  const base64 = (bytes: Uint8Array) => {
    let text = "";
    for (const b of bytes) text += String.fromCharCode(b);
    return btoa(text);
  };
  return {
    async spawn(cmd, opts) {
      const { stdin, ...rest } = opts;
      const body: Record<string, unknown> = { cmd, ...rest };
      if (stdin instanceof Uint8Array) body.stdinBase64 = base64(stdin);
      else if (stdin !== undefined) body.stdin = stdin;
      return (await post("/executions", body)).id;
    },
    wait: (id) => json(`/executions/${encodeURIComponent(id)}?wait=1`),
    async waitRaw(id) {
      const result: Result = await json(
        `/executions/${encodeURIComponent(id)}?wait=1`,
      );
      return {
        ...result,
        stdout: encoder.encode(result.stdout),
        stderr: encoder.encode(result.stderr),
      } as RawResult;
    },
    async kill(id, signal) {
      await call(`/executions/${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(signal === undefined ? {} : { signal }),
      });
    },
    list: () => json("/executions"),
    files: {
      async read(path) {
        const response = await call(
          `/fs/content?path=${encodeURIComponent(path)}`,
        );
        return new Uint8Array(await response.arrayBuffer());
      },
      async write(path, bytes, opts) {
        const headers: Record<string, string> = {
          "content-type": "application/octet-stream",
        };
        if (opts.mode !== undefined) {
          headers["x-yurt-mode"] = opts.mode.toString(8);
        }
        if (opts.atomic === false) headers["x-yurt-atomic"] = "0";
        await call(`/fs/content?path=${encodeURIComponent(path)}`, {
          method: "PUT",
          headers,
          body: bytes as BodyInit,
        });
      },
      list: (path) => json(`/fs/entries?path=${encodeURIComponent(path)}`),
    },
  };
}

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

/** The notebook kernel's launch on the desktop page, through the
 * launcher's `/api/*`: `spawn` starts the line as a host session of its own
 * (`POST /api/sessions`) -- not typed into the user's shell, where ipykernel
 * was job [1] and `kill %1` killed it (yurt-playground#82), and not an
 * execution, whose timeout and slot cap do not fit a process that lives as
 * long as the page -- and `readFile` reads a guest file: a stat first
 * (`/api/fs/stat`, straight from the host; a 404 is "not yet"), so the
 * connection-file poll costs no guest process until the file is there,
 * then the bytes (`/api/fs/content`, a `cat` of the user's own). A
 * restart's spawn sees the previous kernel's session out first: the stop
 * has sent SIGKILL, and the close (a join) is refused with 409 until the
 * process is gone, so it waits for `complete`, briefly. */
export function nativeLaunchHooks(
  token: string,
  fetchApi: typeof fetch = (input, init) => fetch(input, init),
  options: { pollMs?: number; closeWaitMs?: number } = {},
): {
  spawn(line: string): Promise<void>;
  readFile(path: string): Promise<Uint8Array | undefined>;
} {
  const pollMs = options.pollMs ?? 100;
  const closeWaitMs = options.closeWaitMs ?? 10_000;
  const call = (path: string, init: RequestInit = {}) =>
    fetchApi(`/api${path}`, {
      ...init,
      headers: { ...init.headers, authorization: `Bearer ${token}` },
    });
  const failed = async (what: string, response: Response): Promise<Error> => {
    let message = `${what}: ${response.status}`;
    try {
      const body = await response.json();
      if (typeof body.error === "string") message = `${what}: ${body.error}`;
    } catch {
      // Not JSON: the status is the message.
    }
    return new Error(message);
  };
  const sleep = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));
  /** Close the previous kernel's session once its process is gone; a
   * session the host no longer knows (404) is as closed as it gets. */
  const seeOut = async (id: string): Promise<void> => {
    const encoded = encodeURIComponent(id);
    const deadline = Date.now() + closeWaitMs;
    for (;;) {
      const status = await call(`/sessions/${encoded}`);
      if (status.status === 404) {
        await status.body?.cancel();
        return;
      }
      if (!status.ok) throw await failed("close the previous kernel", status);
      if ((await status.json()).complete === true) break;
      if (Date.now() >= deadline) {
        throw new Error(
          `close the previous kernel: still running after ${closeWaitMs} ms`,
        );
      }
      await sleep(pollMs);
    }
    const closed = await call(`/sessions/${encoded}`, { method: "DELETE" });
    if (!closed.ok && closed.status !== 404) {
      throw await failed("close the previous kernel", closed);
    }
    await closed.body?.cancel();
  };
  let previous: string | undefined;
  return {
    async spawn(line) {
      if (previous !== undefined) {
        const closing = previous;
        previous = undefined;
        await seeOut(closing);
      }
      const response = await call("/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ command: line }),
      });
      if (!response.ok) throw await failed("start the kernel", response);
      previous = (await response.json()).id;
    },
    async readFile(path) {
      const encoded = encodeURIComponent(path);
      const stat = await call(`/fs/stat?path=${encoded}`);
      if (stat.status === 404) {
        await stat.body?.cancel();
        return undefined;
      }
      if (!stat.ok) throw await failed(`stat ${path}`, stat);
      await stat.body?.cancel();
      const response = await call(`/fs/content?path=${encoded}`);
      if (!response.ok) throw await failed(`read ${path}`, response);
      return new Uint8Array(await response.arrayBuffer());
    },
  };
}

export async function bootNativePlayground(
  env: PlaygroundEnv,
  /** The launcher's `/api/*` token, when it has the session routes: the
   * kernel then starts as a process of its own. Without it the launch is
   * typed at the prompt, as on a launcher older than the API. */
  api?: { token: string },
): Promise<PlaygroundSession> {
  env.show("connecting to the sandbox");
  const ws = await openSocket("/ws/tty");
  const encoder = new TextEncoder();
  const output = outputFanout(env.term);
  ws.onmessage = (event: MessageEvent) => {
    output.push(new Uint8Array(event.data as ArrayBuffer));
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
  const hooks = api === undefined ? undefined : nativeLaunchHooks(api.token);
  return {
    stop,
    controller,
    terminal,
    ...(hooks === undefined
      ? {}
      : { spawn: hooks.spawn, readFile: hooks.readFile }),
    dialSandboxPort: dialNativePort,
    onOutput: output.onOutput,
    hushOutput: output.hushOutput,
  };
}
