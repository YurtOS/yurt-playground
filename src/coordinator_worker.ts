/// <reference lib="deno.worker" />
/**
 * Browser coordinator. WorkerHost.spawnRootLeader uses Atomics.wait, which
 * is legal here and illegal on the window thread.
 */
import {
  bootPlayground,
  fetchPlaygroundBytes,
  type PlaygroundTerm,
} from "./boot.ts";
import {
  executeCell,
  type KernelPorts,
  restartGuestKernel,
  startGuestKernel,
} from "./jupyter.ts";
import { bootNativePlayground } from "./native.ts";
import {
  type ExecOptions,
  type ExecutionRecord,
  ExecutionRegistry,
  type RawResult,
  type Result,
} from "./executions.ts";
import type {
  JupyterChannel,
  JupyterRequestChannel,
  JupyterTransport,
} from "./jupyter_transport.ts";
import type { JupyterMessage } from "./jupyter_protocol.ts";
import { installCoordinatorWorkerProxy } from "./page_worker_bridge.ts";

installCoordinatorWorkerProxy();
type ToWorker =
  // `kernelPorts` set: the desktop app's native sandbox (see native.ts),
  // reached over WebSockets; otherwise the kernel boots in this worker.
  // `apiToken` opens the launcher's /api/* to the launch (yurt-playground#82).
  | {
    type: "start";
    cols: number;
    rows: number;
    isolated: boolean;
    kernelPorts?: KernelPorts;
    apiToken?: string;
  }
  | { type: "in"; text: string }
  | { type: "resize"; rows: number; cols: number }
  | { type: "cell"; id: string; code: string }
  // Raw Jupyter wire-protocol passthrough for a real frontend (JupyterLite's
  // Yurt kernel plugin): messages go to the guest kernel as sent, and every
  // message the kernel emits comes back with the socket it arrived on.
  | {
    type: "jupyter-send";
    message: JupyterMessage;
    channel: JupyterRequestChannel;
  }
  // Replace the guest kernel with a fresh process (a frontend restart, or a
  // shutdown followed by a start). Answered by `jupyter-restarted`.
  | { type: "jupyter-restart" }
  // A driver's commands (window.yurt, src/agent_api.ts): every request
  // carries a `req` the reply echoes.
  | { type: "yurt-spawn"; req: number; cmd: string; opts: ExecOptions }
  | { type: "yurt-wait"; req: number; id: string; raw: boolean }
  | { type: "yurt-kill"; req: number; id: string; signal?: string }
  | { type: "yurt-list"; req: number };

type FromWorker =
  | { type: "status"; text: string }
  | { type: "out"; bytes: number[] }
  | { type: "error"; message: string }
  | { type: "notebook-ready" }
  | {
    type: "cell-result";
    id: string;
    result: Awaited<ReturnType<typeof executeCell>>;
  }
  | { type: "cell-error"; id: string; message: string }
  | {
    type: "jupyter-message";
    message: JupyterMessage;
    channel: JupyterChannel;
  }
  | { type: "jupyter-restarted" }
  | {
    type: "yurt-reply";
    req: number;
    ok: boolean;
    value?: string | Result | RawResult | ExecutionRecord[] | null;
    error?: string;
  };

let jupyter: JupyterTransport | undefined;
let launchSession: Awaited<ReturnType<typeof bootPlayground>> | undefined;
let executions: ExecutionRegistry | undefined;

async function serveYurt(msg: ToWorker): Promise<void> {
  if (
    msg.type !== "yurt-spawn" && msg.type !== "yurt-wait" &&
    msg.type !== "yurt-kill" && msg.type !== "yurt-list"
  ) return;
  const reply = (ok: boolean, value?: unknown, error?: string) =>
    post({
      type: "yurt-reply",
      req: msg.req,
      ok,
      value: value as never,
      error,
    });
  if (executions === undefined) {
    reply(false, undefined, "the sandbox is not running");
    return;
  }
  try {
    if (msg.type === "yurt-spawn") {
      reply(true, await executions.spawn(msg.cmd, msg.opts));
    } else if (msg.type === "yurt-wait") {
      reply(
        true,
        msg.raw
          ? await executions.waitRaw(msg.id)
          : await executions.wait(msg.id),
      );
    } else if (msg.type === "yurt-kill") {
      await executions.kill(msg.id, msg.signal);
      reply(true, null);
    } else {
      reply(true, executions.list());
    }
  } catch (error) {
    reply(
      false,
      undefined,
      error instanceof Error ? error.message : String(error),
    );
  }
}
let kernelPorts: KernelPorts | undefined;
/** Restarts are serialised: a second request waits for the first. */
let restarting: Promise<void> = Promise.resolve();

function subscribeJupyter(transport: JupyterTransport): void {
  transport.subscribe((message, channel) => {
    post({ type: "jupyter-message", message, channel });
  });
}

function post(msg: FromWorker): void {
  self.postMessage(msg);
}

function workerTerm(init: { cols: number; rows: number }): PlaygroundTerm {
  const dataHandlers: Array<(data: string) => void> = [];
  const resizeHandlers: Array<
    (size: { rows: number; cols: number }) => void
  > = [];
  const term: PlaygroundTerm = {
    cols: init.cols,
    rows: init.rows,
    write(data) {
      const bytes = typeof data === "string"
        ? [...new TextEncoder().encode(data)]
        : [...data];
      post({ type: "out", bytes });
    },
    onData(handler) {
      dataHandlers.push(handler);
    },
    onResize(handler) {
      resizeHandlers.push(handler);
    },
  };
  self.addEventListener("message", (event: MessageEvent<ToWorker>) => {
    const msg = event.data;
    if (msg.type === "in") {
      for (const handler of dataHandlers) handler(msg.text);
    } else if (msg.type === "resize") {
      term.cols = msg.cols;
      term.rows = msg.rows;
      for (const handler of resizeHandlers) {
        handler({ rows: msg.rows, cols: msg.cols });
      }
    }
  });
  return term;
}

self.addEventListener("message", async (event: MessageEvent<ToWorker>) => {
  const msg = event.data;
  await serveYurt(msg);
  if (msg.type === "jupyter-send") {
    if (jupyter === undefined) {
      post({ type: "error", message: "Jupyter is not ready" });
      return;
    }
    try {
      await jupyter.send(msg.message, msg.channel);
    } catch (error) {
      post({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }
  if (msg.type === "jupyter-restart") {
    restarting = restarting.then(async () => {
      if (launchSession === undefined) {
        post({ type: "error", message: "Jupyter is not ready" });
        return;
      }
      const previous = jupyter;
      jupyter = undefined;
      try {
        post({ type: "status", text: "restarting Jupyter" });
        jupyter = await restartGuestKernel(
          launchSession,
          previous,
          kernelPorts,
        );
        subscribeJupyter(jupyter);
        post({ type: "jupyter-restarted" });
      } catch (error) {
        post({
          type: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    });
    await restarting;
    return;
  }
  if (msg.type === "cell") {
    if (jupyter === undefined) {
      post({ type: "error", message: "Jupyter is not ready" });
      return;
    }
    try {
      post({
        type: "cell-result",
        id: msg.id,
        result: await executeCell(jupyter, msg.code),
      });
    } catch (error) {
      post({
        type: "cell-error",
        id: msg.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }
  if (msg.type !== "start") return;
  let session: Awaited<ReturnType<typeof bootPlayground>> | undefined;
  try {
    kernelPorts = msg.kernelPorts;
    const env = {
      isolated: msg.isolated,
      fetchBytes: (path: string) =>
        fetchPlaygroundBytes(path, (progress) => {
          const percent = progress.total === undefined
            ? `${progress.loaded} bytes`
            : `${Math.round(progress.loaded / progress.total * 100)}%`;
          post({ type: "status", text: `loading ${path}: ${percent}` });
        }),
      show: (text: string) => post({ type: "status", text }),
      term: workerTerm({ cols: msg.cols, rows: msg.rows }),
    };
    session = kernelPorts === undefined
      ? await bootPlayground(env)
      : await bootNativePlayground(
        env,
        msg.apiToken === undefined ? undefined : { token: msg.apiToken },
      );
    if (session.process !== undefined && session.signal !== undefined) {
      executions = new ExecutionRegistry(session.process, session.signal);
    }
    post({ type: "status", text: "starting Jupyter" });
    launchSession = session;
    // ipykernel's imports are JIT-bound: ~30 s on a laptop, minutes on a
    // small or busy machine (yurt-playground#89). A count that moves is
    // the difference between slow and stuck.
    const started = Date.now();
    const ticking = setInterval(() => {
      const seconds = Math.round((Date.now() - started) / 1000);
      post({ type: "status", text: `starting Jupyter (${seconds} s)` });
    }, 5000);
    try {
      jupyter = await startGuestKernel(session, kernelPorts);
    } finally {
      clearInterval(ticking);
    }
    subscribeJupyter(jupyter);
    post({ type: "notebook-ready" });
  } catch (error) {
    try {
      session?.stop();
    } catch {
      // The guest may already have stopped while startup failed.
    }
    post({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
});
