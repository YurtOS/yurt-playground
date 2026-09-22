import { attachGuestWorkerFactory } from "./page_worker_bridge.ts";
import { mountNotebook } from "./notebook.ts";
import { createPlaygroundTerminal } from "./terminal.ts";
import type { JupyterPartial, JupyterReply } from "./jupyter.ts";
import {
  type DesktopInfo,
  desktopInfo,
  nativeYurtTransport,
} from "./native.ts";
import { announceSandbox, anotherSandboxRunning } from "./tab_presence.ts";
import {
  createYurt,
  type Yurt,
  type YurtStatus,
  type YurtTransport,
} from "./agent_api.ts";
import type { ExecOptions } from "./executions.ts";

type FromWorker =
  | { type: "status"; text: string }
  | { type: "out"; bytes: number[] }
  | { type: "error"; message: string }
  | { type: "notebook-ready" }
  | {
    type: "yurt-reply";
    req: number;
    ok: boolean;
    value?: unknown;
    error?: string;
  }
  | { type: "cell-stream"; id: string; partial: JupyterPartial }
  | { type: "cell-result"; id: string; result: JupyterReply }
  | { type: "cell-error"; id: string; message: string };

/** Answers other tabs' "who has a sandbox?" while this one has one. */
let stopAnnouncing: () => void = () => {};

/**
 * window.yurt (src/agent_api.ts): a driver's view of the sandbox, present
 * from the first script -- idle before Start, failed when the page refuses
 * to boot -- so a driver can always read `status` and wait on `ready`.
 * The transport is wired once the coordinator worker exists.
 */
const yurtState = (() => {
  let status: YurtStatus = "idle";
  let resolveReady: () => void = () => {};
  let rejectReady: (e: Error) => void = () => {};
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  ready.catch(() => {});
  let transport: YurtTransport | undefined;
  const notBooted = () => Promise.reject(new Error(`the sandbox is ${status}`));
  const proxy: YurtTransport = {
    spawn: (cmd, opts) => transport?.spawn(cmd, opts) ?? notBooted(),
    wait: (id) => transport?.wait(id) ?? notBooted(),
    waitRaw: (id) => transport?.waitRaw(id) ?? notBooted(),
    kill: (id, signal) => transport?.kill(id, signal) ?? notBooted(),
    list: () => transport?.list() ?? notBooted(),
    get files() {
      return transport?.files;
    },
  };
  const set = (next: YurtStatus) => {
    status = next;
    document.documentElement.dataset.yurtStatus = next;
  };
  set("idle");
  (globalThis as { yurt?: unknown }).yurt = createYurt(proxy, {
    current: () => status,
    ready,
  });
  return {
    set,
    isRunning: () => status === "running",
    running() {
      set("running");
      byId("export-home").hidden = false;
      resolveReady();
    },
    failed(message: string) {
      if (status === "failed") return;
      set("failed");
      rejectReady(new Error(message));
    },
    connect(t: YurtTransport) {
      transport = t;
    },
  };
})();

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
  interruptCell: { current: () => void },
  desktop: DesktopInfo | undefined,
): void {
  const kernelPorts = desktop?.kernelPorts;
  const status = byId("status");
  const term = createPlaygroundTerminal(byId("term"));
  // Classic worker: Chrome will not start a nested *module* Worker.
  // A classic coordinator can spawn the module guest bootstrap.
  const worker = new Worker("/coordinator.bundle.js");
  attachGuestWorkerFactory(worker);
  execute.current = (id, code) => {
    worker.postMessage({ type: "cell", id, code });
  };
  interruptCell.current = () => {
    worker.postMessage({ type: "cell-interrupt" });
  };
  // A boot that dies before the shell has shown anything is explained in
  // the terminal's place (a tablet gets its likely cause too); once a shell
  // is on screen the status bar alone carries the message, so the shell
  // stays usable.
  let terminalEmpty = true;
  const fail = (message: string) => {
    // A tab with a failed boot has no sandbox to speak for.
    stopAnnouncing();
    stopAnnouncing = () => {};
    rememberBooting(undefined);
    if (!terminalEmpty) {
      status.textContent = `failed: ${message}`;
      return;
    }
    status.textContent = "failed";
    showFailure(deviceClass() === "tablet" ? "tablet" : "error", message);
  };
  // window.yurt (src/agent_api.ts): a driver's view of the same sandbox.
  // Requests go to the worker with a number the reply echoes.
  const pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  let nextReq = 1;
  const ask = <T>(message: Record<string, unknown>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const req = nextReq++;
      pending.set(req, { resolve: resolve as (v: unknown) => void, reject });
      worker.postMessage({ ...message, req });
    });
  // In the tab, the registry is the worker's; on the desktop it is the
  // launcher's (/api/*, src/desktop_api.ts), shared with any program on
  // the machine, and the token from /desktop.json opens it.
  const transport: YurtTransport = desktop?.apiToken !== undefined
    ? nativeYurtTransport(desktop.apiToken)
    : {
      spawn: (cmd: string, opts: ExecOptions) =>
        ask({ type: "yurt-spawn", cmd, opts }),
      wait: (id: string) => ask({ type: "yurt-wait", id, raw: false }),
      waitRaw: (id: string) => ask({ type: "yurt-wait", id, raw: true }),
      kill: (id: string, signal?: string) =>
        ask({ type: "yurt-kill", id, signal }),
      list: () => ask({ type: "yurt-list" }),
    };
  yurtState.connect(transport);
  yurtState.set("booting");
  worker.onmessage = (event: MessageEvent<FromWorker>) => {
    const msg = event.data;
    // The coordinator's empty status is "booted"; say so.
    if (msg.type === "status") {
      status.textContent = msg.text || "running";
      rememberBooting(msg.text || "running");
      if (msg.text === "") yurtState.running();
    }
    if (msg.type === "error") {
      fail(msg.message);
      // Only a boot failure is the sandbox's failure: an error once the
      // shell is up ("Jupyter is not ready", a restart that failed) leaves
      // exec working, and the status says so.
      if (!yurtState.isRunning()) yurtState.failed(msg.message);
    }
    if (msg.type === "out") {
      terminalEmpty = false;
      term.write(new Uint8Array(msg.bytes));
    }
    if (msg.type === "notebook-ready") {
      notebook.ready();
      status.textContent = "running";
      rememberBooting(undefined);
    }
    if (msg.type === "yurt-reply") {
      const waiter = pending.get(msg.req);
      pending.delete(msg.req);
      if (waiter === undefined) return;
      if (msg.ok) waiter.resolve(msg.value);
      else waiter.reject(new Error(msg.error ?? "yurt request failed"));
    }
    if (msg.type === "cell-stream") notebook.stream(msg.id, msg.partial);
    if (msg.type === "cell-result") notebook.result(msg.id, msg.result);
    if (msg.type === "cell-error") notebook.error(msg.id, msg.message);
  };
  worker.onerror = (event) => {
    const message = event.message || "coordinator worker failed";
    fail(message);
    yurtState.failed(message);
    // Nothing will answer them now.
    for (const waiter of pending.values()) waiter.reject(new Error(message));
    pending.clear();
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
    apiToken: desktop?.apiToken,
  });
}

/** The "Download home" control: `yurt.fs.export()` in a process of its
 * own, so a stuck foreground command does not cost the session's files
 * (#81). Shown once the sandbox runs; disabled while an export is in
 * flight; a failure lands in the status line. */
function wireExportHome(): void {
  const button = byId("export-home") as HTMLButtonElement;
  const status = byId("status");
  button.addEventListener("click", async () => {
    const yurt = (globalThis as { yurt?: Yurt }).yurt;
    if (yurt === undefined) return;
    button.disabled = true;
    try {
      await yurt.fs.export();
    } catch (error) {
      status.textContent = `download home failed: ${
        error instanceof Error ? error.message : String(error)
      }`;
    } finally {
      button.disabled = false;
    }
  });
}

async function runPage(): Promise<void> {
  watchNetwork(byId("net"));
  wireExportHome();
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
    byId("offline-note").hidden = true;
  }
  if (desktop === undefined && globalThis.crossOriginIsolated !== true) {
    byId("status").textContent = "need COOP/COEP";
    yurtState.failed("the page is not cross-origin isolated");
    globalThis.location.replace("./unsupported.html");
    throw new Error("not crossOriginIsolated");
  }
  // The cell is part of the workspace from the first screen, waiting for
  // the sandbox; its Run reaches the coordinator once there is one.
  const execute = { current: (_id: string, _code: string) => {} };
  const interruptCell = { current: () => {} };
  const notebook = mountNotebook(
    byId("notebook"),
    (id, code) => execute.current(id, code),
    () => interruptCell.current(),
  );
  const start = document.getElementById("start");
  const begin = () => {
    if (start) start.hidden = true;
    // Two sandboxes in one browser share the CPU (yurt-playground#84): say
    // so before this one boots, and answer the next tab that asks. The
    // desktop app's sandbox is native and one per launcher, so neither
    // applies there.
    if (desktop === undefined) {
      void anotherSandboxRunning().then((another) => {
        if (another) byId("another-tab-note").hidden = false;
      });
      stopAnnouncing = announceSandbox();
    }
    boot(notebook, execute, interruptCell, desktop);
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
      yurtState.failed(
        device === "phone"
          ? "not on a phone"
          : `a previous boot was cut off at ${cutOff}`,
      );
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
