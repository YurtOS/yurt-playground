import { createPlaygroundTerminal } from "./terminal.ts";

type FromWorker =
  | { type: "status"; text: string }
  | { type: "out"; bytes: number[] }
  | { type: "error"; message: string };

function runPage(): void {
  const status = document.getElementById("status");
  const termHost = document.getElementById("term");
  if (termHost === null) throw new Error("missing #term");
  if (globalThis.crossOriginIsolated !== true) {
    if (status) status.textContent = "need COOP/COEP";
    throw new Error("not crossOriginIsolated");
  }
  const term = createPlaygroundTerminal(termHost);
  // Classic worker: Chrome will not start a nested *module* Worker.
  // A classic coordinator can spawn the module guest bootstrap.
  const worker = new Worker("/coordinator.bundle.js");
  worker.onmessage = (event: MessageEvent<FromWorker>) => {
    const msg = event.data;
    if (msg.type === "status" && status) status.textContent = msg.text;
    if (msg.type === "error" && status) status.textContent = msg.message;
    if (msg.type === "out") term.write(new Uint8Array(msg.bytes));
  };
  worker.onerror = (event) => {
    if (status) {
      status.textContent = event.message || "coordinator worker failed";
    }
  };
  term.onData((text) => worker.postMessage({ type: "in", text }));
  term.onResize((size) =>
    worker.postMessage({ type: "resize", rows: size.rows, cols: size.cols })
  );
  worker.postMessage({
    type: "start",
    cols: term.cols,
    rows: term.rows,
    isolated: true,
  });
}

runPage();
