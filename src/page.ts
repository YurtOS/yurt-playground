import { attachGuestWorkerFactory } from "./page_worker_bridge.ts";
import { mountNotebook } from "./notebook.ts";
import { createPlaygroundTerminal } from "./terminal.ts";
import type { JupyterReply } from "./jupyter.ts";
import { desktopInfo } from "./native.ts";

type FromWorker =
  | { type: "status"; text: string }
  | { type: "out"; bytes: number[] }
  | { type: "error"; message: string }
  | { type: "notebook-ready" }
  | { type: "cell-result"; id: string; result: JupyterReply }
  | { type: "cell-error"; id: string; message: string };

function byId(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`missing #${id}`);
  return element;
}

/** The tab's network state, next to the status: the proof that nothing
 * leaves the page is that this can say offline and the cell still answers. */
function watchNetwork(net: HTMLElement): void {
  const show = () => {
    const online = navigator.onLine;
    net.dataset.online = String(online);
    net.textContent = online ? "online" : "offline, still running";
  };
  globalThis.addEventListener("online", show);
  globalThis.addEventListener("offline", show);
  show();
}

/** Boot the sandbox into the page: the terminal pane and the cell. */
function boot(
  notebook: ReturnType<typeof mountNotebook>,
  execute: { current: (id: string, code: string) => void },
  kernelPorts: [number, number, number, number, number] | undefined,
): void {
  const status = byId("status");
  const term = createPlaygroundTerminal(byId("term"));
  // Classic worker: Chrome will not start a nested *module* Worker.
  // A classic coordinator can spawn the module guest bootstrap.
  const worker = new Worker("/coordinator.bundle.js");
  attachGuestWorkerFactory(worker);
  execute.current = (id, code) => {
    worker.postMessage({ type: "cell", id, code });
  };
  worker.onmessage = (event: MessageEvent<FromWorker>) => {
    const msg = event.data;
    // The coordinator's empty status is "booted"; say so.
    if (msg.type === "status") status.textContent = msg.text || "running";
    if (msg.type === "error") status.textContent = msg.message;
    if (msg.type === "out") term.write(new Uint8Array(msg.bytes));
    if (msg.type === "notebook-ready") {
      notebook.ready();
      status.textContent = "running";
    }
    if (msg.type === "cell-result") notebook.result(msg.id, msg.result);
    if (msg.type === "cell-error") notebook.error(msg.id, msg.message);
  };
  worker.onerror = (event) => {
    status.textContent = event.message || "coordinator worker failed";
  };
  term.onData((text) => worker.postMessage({ type: "in", text }));
  term.onResize((size) =>
    worker.postMessage({ type: "resize", rows: size.rows, cols: size.cols })
  );
  status.textContent = "booting";
  worker.postMessage({
    type: "start",
    cols: term.cols,
    rows: term.rows,
    isolated: globalThis.crossOriginIsolated === true,
    kernelPorts,
  });
}

async function runPage(): Promise<void> {
  watchNetwork(byId("net"));
  // The desktop app runs the sandbox natively; only the in-tab kernel needs
  // cross-origin isolation, and a page served without it cannot boot at all
  // and goes to the explanation.
  const desktop = await desktopInfo();
  if (desktop === undefined && globalThis.crossOriginIsolated !== true) {
    byId("status").textContent = "need COOP/COEP";
    globalThis.location.replace("./unsupported.html");
    throw new Error("not crossOriginIsolated");
  }
  // The cell is part of the workspace from the first screen, waiting for
  // the sandbox; its Run reaches the coordinator once there is one.
  const execute = { current: (_id: string, _code: string) => {} };
  const notebook = mountNotebook(byId("notebook"), (id, code) => {
    execute.current(id, code);
  });
  const start = document.getElementById("start");
  const begin = () => {
    if (start) start.hidden = true;
    boot(notebook, execute, desktop?.kernelPorts);
  };
  // The workspace opens with one action; `?start` (the old terminal page's
  // redirect, and the acceptance tests) skips it.
  if (start === null || new URL(location.href).searchParams.has("start")) {
    begin();
    return;
  }
  byId("start-sandbox").addEventListener("click", begin, { once: true });
}

void runPage();
