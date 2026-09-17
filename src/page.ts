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

/**
 * Phones get no Start: an iPhone downloads everything and Safari reloads
 * the tab at "starting Jupyter", since the boot needs around a gigabyte in
 * one tab. Tablets get the note and may try; iPadOS reports a Mac, so the
 * coarse pointer on a narrow screen is what identifies one.
 */
function deviceClass(): "phone" | "tablet" | "desktop" {
  const uaData = (navigator as { userAgentData?: { mobile?: boolean } })
    .userAgentData;
  const ua = navigator.userAgent;
  if (/iPad/.test(ua)) return "tablet";
  if (uaData?.mobile === true || /iPhone|iPod|Android.*Mobile/i.test(ua)) {
    return "phone";
  }
  if (
    /Android|Silk/i.test(ua) ||
    (matchMedia("(pointer: coarse)").matches && innerWidth < 900)
  ) return "tablet";
  return "desktop";
}

/**
 * A browser that runs out of memory mid-boot reloads the tab, and the page
 * that could have said so is gone. The status is kept in sessionStorage
 * from Start until the notebook is ready (or the boot fails in-page), so
 * the reloaded page can tell a cut-off boot from a first visit.
 */
const BOOTING_KEY = "yurt-playground-booting";
function rememberBooting(status: string | undefined): void {
  try {
    if (status === undefined) sessionStorage.removeItem(BOOTING_KEY);
    else sessionStorage.setItem(BOOTING_KEY, status);
  } catch {
    // Storage blocked: the boot still runs, a cut-off one is just unexplained.
  }
}
function cutOffBoot(): string | undefined {
  try {
    const status = sessionStorage.getItem(BOOTING_KEY) ?? undefined;
    sessionStorage.removeItem(BOOTING_KEY);
    return status;
  } catch {
    return undefined;
  }
}

/**
 * The failure pane in the terminal's place: one paragraph for the known
 * cause (`why`), the browser's own words as `reason` when there are any.
 * A phone is refused before Start; the others come from the boot.
 */
function showFailure(
  why: "phone" | "tablet" | "reloaded" | "error",
  reason?: string,
): void {
  byId("start").hidden = true;
  const failed = byId("failed");
  for (const p of failed.querySelectorAll<HTMLElement>("[data-why]")) {
    p.hidden = p.dataset.why !== why;
  }
  byId("failed-reason").hidden = reason === undefined;
  byId("failed-reason").textContent = reason ?? "";
  byId("failed-retry").hidden = why === "phone";
  failed.hidden = false;
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
  // A boot that dies before the shell has shown anything is explained in
  // the terminal's place (a tablet gets its likely cause too); once a shell
  // is on screen the status bar alone carries the message, so the shell
  // stays usable.
  let terminalEmpty = true;
  const fail = (message: string) => {
    rememberBooting(undefined);
    if (!terminalEmpty) {
      status.textContent = `failed: ${message}`;
      return;
    }
    status.textContent = "failed";
    showFailure(deviceClass() === "tablet" ? "tablet" : "error", message);
  };
  worker.onmessage = (event: MessageEvent<FromWorker>) => {
    const msg = event.data;
    // The coordinator's empty status is "booted"; say so.
    if (msg.type === "status") {
      status.textContent = msg.text || "running";
      rememberBooting(msg.text || "running");
    }
    if (msg.type === "error") fail(msg.message);
    if (msg.type === "out") {
      terminalEmpty = false;
      term.write(new Uint8Array(msg.bytes));
    }
    if (msg.type === "notebook-ready") {
      notebook.ready();
      status.textContent = "running";
      rememberBooting(undefined);
    }
    if (msg.type === "cell-result") notebook.result(msg.id, msg.result);
    if (msg.type === "cell-error") notebook.error(msg.id, msg.message);
  };
  worker.onerror = (event) => {
    fail(event.message || "coordinator worker failed");
  };
  term.onData((text) => worker.postMessage({ type: "in", text }));
  term.onResize((size) =>
    worker.postMessage({ type: "resize", rows: size.rows, cols: size.cols })
  );
  status.textContent = "booting";
  rememberBooting("booting");
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
  // The page's own claim is about the tab; the desktop app's sandbox is on
  // this machine and on the network, and the header should say which.
  if (desktop !== undefined) {
    byId("lead").textContent =
      "A Linux sandbox running natively on this machine, shown in this tab: " +
      "a shell, Python 3.14, NumPy, Jupyter, with network access.";
  }
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
  // Only the in-tab kernel has the memory problem; the desktop app's page
  // runs the sandbox natively.
  if (desktop === undefined) {
    const device = deviceClass();
    if (device === "tablet") byId("mobile-note").hidden = false;
    const cutOff = cutOffBoot();
    if (device === "phone" || cutOff !== undefined) {
      byId("status").textContent = "failed";
      showFailure(device === "phone" ? "phone" : "reloaded", cutOff);
      return;
    }
  }
  // The boot memory has been read (and cleared) by now; a test that plants
  // one for the next load must wait for this, or this load consumes it.
  document.documentElement.dataset.settled = "";
  // The workspace opens with one action; `?start` (the old terminal page's
  // redirect, and the acceptance tests) skips it.
  if (start === null || new URL(location.href).searchParams.has("start")) {
    begin();
    return;
  }
  byId("start-sandbox").addEventListener("click", begin, { once: true });
}

void runPage();
