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
import { executeCell, startGuestKernel } from "./jupyter.ts";
import type { JupyterTransport } from "./jupyter_transport.ts";
import { installCoordinatorWorkerProxy } from "./page_worker_bridge.ts";

installCoordinatorWorkerProxy();
type ToWorker =
  | {
    type: "start";
    cols: number;
    rows: number;
    isolated: boolean;
    mode?: string;
  }
  | { type: "in"; text: string }
  | { type: "resize"; rows: number; cols: number }
  | { type: "cell"; id: string; code: string };

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
  | { type: "cell-error"; id: string; message: string };

let jupyter: JupyterTransport | undefined;

const TEST_BUNDLE = (globalThis as typeof globalThis & {
  __YURT_PLAYGROUND_TEST_BUNDLE__?: boolean;
})
  .__YURT_PLAYGROUND_TEST_BUNDLE__ === true;

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
    session = await bootPlayground({
      isolated: msg.isolated,
      fetchBytes: (path) =>
        fetchPlaygroundBytes(path, (progress) => {
          const percent = progress.total === undefined
            ? `${progress.loaded} bytes`
            : `${Math.round(progress.loaded / progress.total * 100)}%`;
          post({ type: "status", text: `loading ${path}: ${percent}` });
        }),
      show: (text) => post({ type: "status", text }),
      term: workerTerm({ cols: msg.cols, rows: msg.rows }),
    });
    if (msg.mode === "workerhost-repro") {
      if (!TEST_BUNDLE) throw new Error("workerhost reproduction is disabled");
      post({ type: "status", text: "shell-ready" });
      return;
    }
    post({ type: "status", text: "starting Jupyter" });
    jupyter = await startGuestKernel(session);
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
