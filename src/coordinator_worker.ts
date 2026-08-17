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
import { installCoordinatorWorkerProxy } from "./page_worker_bridge.ts";

installCoordinatorWorkerProxy();
type ToWorker =
  | { type: "start"; cols: number; rows: number; isolated: boolean }
  | { type: "in"; text: string }
  | { type: "resize"; rows: number; cols: number };

type FromWorker =
  | { type: "status"; text: string }
  | { type: "out"; bytes: number[] }
  | { type: "error"; message: string };

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
  if (msg.type !== "start") return;
  try {
    await bootPlayground({
      isolated: msg.isolated,
      fetchBytes: fetchPlaygroundBytes,
      show: (text) => post({ type: "status", text }),
      term: workerTerm({ cols: msg.cols, rows: msg.rows }),
    });
  } catch (error) {
    post({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
});
