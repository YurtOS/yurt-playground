import { attachGuestWorkerFactory } from "./page_worker_bridge.ts";
import {
  hideMemoryRefused,
  MEMORY_REFUSED_RELOAD_ID,
  type MemoryRefusedMessage,
  showMemoryRefused,
} from "./memory_refused.ts";
import { mountNotebook, type NotebookView } from "./notebook.ts";
import { createStatusLine, type StatusLine } from "./status_line.ts";
import {
  fetchSitePins,
  pythonInstallRequest,
  pythonInstallState,
} from "./python_install.ts";
import { mountAgentPane } from "./agent_pane.ts";
import { UPLOAD_DIR, uploadFiles } from "./upload.ts";
import {
  catalogRows,
  formatBytes,
  loadCatalog,
  TRUSTED_REPOS_PATH,
} from "./packages.ts";
import { createPlaygroundTerminal } from "./terminal.ts";
import { deviceClass } from "./device.ts";
import type { JupyterReply, JupyterStream } from "./jupyter.ts";
import {
  type DesktopInfo,
  desktopInfo,
  nativeYurtTransport,
} from "./native.ts";
import { announceSandbox, watchForAnotherSandbox } from "./tab_presence.ts";
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
  // `endsBoot`: the start's own outcome, not a later error (a cell's).
  | { type: "error"; message: string; endsBoot?: true }
  | { type: "notebook-ready" }
  | { type: "shell-ready" }
  // The image has no python3: the shell runs, Jupyter was not launched.
  | { type: "python-missing"; error?: string }
  | { type: "pkg-progress"; req: number; text: string }
  | { type: "snapshot-captured"; blob: Blob; ms: number }
  | {
    type: "yurt-reply" | "pkg-reply";
    req: number;
    ok: boolean;
    value?: unknown;
    error?: string;
  }
  | { type: "cell-stream"; id: string; chunk: JupyterStream }
  | { type: "cell-result"; id: string; result: JupyterReply }
  | { type: "cell-error"; id: string; message: string }
  | MemoryRefusedMessage;

/** A package install in the in-tab sandbox, once it boots: the coordinator
 * runs it (src/packages.ts), one install at a time with the automatic Python
 * install. The desktop app's sandbox has a network and installs with `pkg`
 * itself. */
let packageInstall:
  | ((name: string, progress: (text: string) => void) => Promise<string>)
  | undefined;

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
      byId("upload-files").hidden = false;
      byId("packages-toggle").hidden = packageInstall === undefined;
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
  // A phone is not a boot that failed: nothing was started.
  byId("failed-title").textContent = why === "phone"
    ? "The sandbox does not run on phones"
    : "The sandbox did not start";
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
  notebook: NotebookView,
  execute: { current: (id: string, code: string) => void },
  interruptCell: { current: (id: string) => void },
  desktop: DesktopInfo | undefined,
  stopWatchingForAnotherSandbox: () => void,
  /** The shell alone: no Python install and no Jupyter (a tablet, or a
   * phone started anyway). */
  noPython: boolean,
  status: StatusLine,
  smallDevice: boolean,
): void {
  const kernelPorts = desktop?.kernelPorts;
  // A refusal belongs to the session that had it.
  hideMemoryRefused(byId);
  const term = createPlaygroundTerminal(byId("term"));
  // Classic worker: Chrome will not start a nested *module* Worker.
  // A classic coordinator can spawn the module guest bootstrap.
  const worker = new Worker("/coordinator.bundle.js");
  attachGuestWorkerFactory(worker);
  execute.current = (id, code) => {
    worker.postMessage({ type: "cell", id, code });
  };
  interruptCell.current = (id) => {
    worker.postMessage({ type: "cell-interrupt", id });
  };
  // A boot that dies before the shell has shown anything is explained in
  // the terminal's place (a tablet gets its likely cause too); once a shell
  // is on screen the status bar alone carries the message, so the shell
  // stays usable.
  let terminalEmpty = true;
  let notebookReady = false;
  // The cell already says why there is no kernel; an error after that
  // (a restart refused) must not say "Jupyter did not start" over it.
  let pythonMissing = false;
  let installingPython = false;
  // From Start (or an Install after python-missing, which may start a fresh
  // sandbox) until that boot ends: only then is a status worth keeping for
  // a reloaded tab. A later one (a Jupyter restart) is not a boot.
  let booting = true;
  const endBoot = () => {
    booting = false;
    rememberBooting(undefined);
  };
  const pinsPromise = fetchSitePins();
  // The cell's Install: enabled when the pins name a slim image; after a
  // failed install it says why and tries again.
  const showPythonMissing = (error: string | undefined) =>
    void pinsPromise.then((pins) =>
      notebook.pythonMissing(
        pythonInstallState(pins),
        () => {
          // A retry: what comes next (a kernel that fails, say) is this
          // attempt's, not the missing Python's.
          pythonMissing = false;
          booting = true;
          notebook.installing("installing Python");
          worker.postMessage({ type: "python-install" });
        },
        error,
      )
    );
  const sandboxGone = () => {
    stopAnnouncing();
    stopAnnouncing = () => {};
    stopWatchingForAnotherSandbox();
  };
  const fail = (message: string) => {
    if (!terminalEmpty) {
      status.failure(`failed: ${message}`);
      // The shell is up and stays; a Jupyter that did not start leaves
      // the cell with nothing to wait for.
      if (!notebookReady && !noPython && !pythonMissing) {
        notebook.unavailable("Jupyter did not start");
      }
      return;
    }
    status.failure("failed");
    showFailure(deviceClass() === "tablet" ? "tablet" : "error", message);
    notebook.unavailable("no sandbox");
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
  /** Each install's progress, by request. */
  const progressOf = new Map<number, (text: string) => void>();
  if (desktop === undefined) {
    packageInstall = (name, progress) =>
      new Promise<string>((resolve, reject) => {
        const req = nextReq++;
        progressOf.set(req, progress);
        pending.set(req, {
          resolve: (value) => {
            progressOf.delete(req);
            resolve(value as string);
          },
          reject: (error) => {
            progressOf.delete(req);
            reject(error);
          },
        });
        worker.postMessage({
          type: "pkg-install",
          req,
          name,
          tablet: smallDevice,
        });
      });
  }
  yurtState.set("booting");
  worker.onmessage = (event: MessageEvent<FromWorker>) => {
    const msg = event.data;
    // The coordinator's empty status is "booted"; say so.
    if (msg.type === "status") {
      // Installing Python, then starting Jupyter on it, is the cell's
      // wait: say so there too.
      if (!notebookReady && /^(installing Python|Python:)/.test(msg.text)) {
        installingPython = true;
      }
      if (!notebookReady && installingPython && msg.text !== "") {
        notebook.installing(msg.text);
      }
      status.progress(msg.text || "running");
      if (booting) rememberBooting(msg.text || "running");
      if (msg.text === "") yurtState.running();
    }
    if (msg.type === "error") {
      if (msg.endsBoot === true) endBoot();
      fail(msg.message);
      // Only a boot failure is the sandbox's failure: an error once the
      // shell is up ("Jupyter is not ready", a restart that failed) leaves
      // exec working, and the status says so.
      if (!yurtState.isRunning()) {
        yurtState.failed(msg.message);
        sandboxGone();
      }
    }
    showMemoryRefused(msg, byId);
    if (msg.type === "out") {
      terminalEmpty = false;
      term.write(new Uint8Array(msg.bytes));
    }
    if (msg.type === "notebook-ready") {
      notebookReady = true;
      notebook.ready();
      status.progress("running", { settled: true });
      endBoot();
    }
    // A tablet's or phone's whole session is the shell; once it runs the
    // boot is over.
    if (msg.type === "shell-ready") {
      status.progress("running", { settled: true });
      endBoot();
    }
    // The slim image: the shell is the session until Python is installed.
    // The boot is over here too, so a later reload is no cut-off boot.
    if (msg.type === "python-missing") {
      pythonMissing = true;
      showPythonMissing(msg.error);
      status.progress("running", { settled: true });
      endBoot();
    }
    if (msg.type === "pkg-progress") progressOf.get(msg.req)?.(msg.text);
    if (msg.type === "snapshot-captured") saveSnapshot(msg.blob, msg.ms);
    if (msg.type === "yurt-reply" || msg.type === "pkg-reply") {
      const waiter = pending.get(msg.req);
      pending.delete(msg.req);
      if (waiter === undefined) return;
      if (msg.ok) waiter.resolve(msg.value);
      else waiter.reject(new Error(msg.error ?? "yurt request failed"));
    }
    if (msg.type === "cell-stream") notebook.stream(msg.id, msg.chunk);
    if (msg.type === "cell-result") notebook.result(msg.id, msg.result);
    if (msg.type === "cell-error") notebook.error(msg.id, msg.message);
  };
  worker.onerror = (event) => {
    endBoot();
    const message = event.message || "coordinator worker failed";
    fail(message);
    yurtState.failed(message);
    sandboxGone();
    // Nothing will answer them now.
    for (const waiter of pending.values()) waiter.reject(new Error(message));
    pending.clear();
  };
  term.onData((text) => worker.postMessage({ type: "in", text }));
  term.onResize((size) =>
    worker.postMessage({ type: "resize", rows: size.rows, cols: size.cols })
  );
  status.progress("booting");
  rememberBooting("booting");
  // On the slim image the coordinator installs the newest complete Python
  // set before Jupyter; a tablet's session, and a phone's, is the shell
  // alone, and the desktop app's sandbox needs no page to install anything.
  void pinsPromise.then((pins) =>
    worker.postMessage({
      type: "start",
      cols: term.cols,
      rows: term.rows,
      isolated: globalThis.crossOriginIsolated === true,
      kernelPorts,
      apiToken: desktop?.apiToken,
      noJupyter: noPython,
      python: noPython || desktop !== undefined || pins === undefined
        ? undefined
        : pythonInstallRequest(pins),
      tablet: smallDevice,
      snapshot: snapshotMode(),
    })
  );
}

/** `?snapshot=1` restores the sealed sandbox (src/sandbox_snapshot.ts);
 * `?snapshot=capture` makes one. Off by default. */
function snapshotMode(): "restore" | "capture" | undefined {
  const value = new URL(location.href).searchParams.get("snapshot");
  if (value === "1") return "restore";
  if (value === "capture") return "capture";
  return undefined;
}

/** `?snapshot=capture`'s result, saved as a download. */
function saveSnapshot(blob: Blob, ms: number): void {
  console.log(`[snapshot] sealed and encoded in ${ms} ms: ${blob.size} bytes`);
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "sandbox.seal.gz";
  document.body.append(link);
  link.click();
  link.remove();
}

/** The "Download home" control: `yurt.fs.export()` in a process of its
 * own, so a stuck foreground command does not cost the session's files
 * (#81). Shown once the sandbox runs; disabled while an export is in
 * flight; a failure lands in the status line. */
function wireExportHome(status: StatusLine): void {
  const button = byId("export-home") as HTMLButtonElement;
  button.addEventListener("click", async () => {
    const yurt = (globalThis as { yurt?: Yurt }).yurt;
    if (yurt === undefined) return;
    button.disabled = true;
    try {
      await yurt.fs.export();
    } catch (error) {
      status.notice(
        `download home failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { error: true },
      );
    } finally {
      button.disabled = false;
    }
  });
}

/** The "Upload" control and a drop on the terminal: files from this device
 * into /home/user (src/upload.ts). Works once the sandbox runs; progress
 * and failures land in the status line. */
function wireUpload(status: StatusLine): void {
  const button = byId("upload-files") as HTMLButtonElement;
  const input = byId("upload-input") as HTMLInputElement;
  // One upload at a time, from the button or a drop.
  let busy = false;
  const upload = async (files: FileList | null) => {
    const yurt = (globalThis as { yurt?: Yurt }).yurt;
    if (yurt === undefined || files === null || files.length === 0) return;
    if (yurt.status !== "running") {
      status.notice("upload: the sandbox is not running", { error: true });
      return;
    }
    if (busy) {
      status.notice("upload: another upload is still running", {
        error: true,
      });
      return;
    }
    busy = true;
    button.disabled = true;
    try {
      const written = await uploadFiles(
        yurt,
        Array.from(files),
        (message) => status.notice(message),
      );
      status.notice(
        written.length === 1
          ? `uploaded ${written[0]}`
          : `uploaded ${written.length} files to ${UPLOAD_DIR}`,
      );
    } catch (error) {
      status.notice(error instanceof Error ? error.message : String(error), {
        error: true,
      });
    } finally {
      busy = false;
      button.disabled = false;
      input.value = "";
    }
  };
  button.addEventListener("click", () => input.click());
  input.addEventListener("change", () => upload(input.files));
  const target = byId("term-wrap");
  target.addEventListener("dragover", (event) => {
    if (event.dataTransfer?.types.includes("Files")) event.preventDefault();
  });
  target.addEventListener("drop", (event) => {
    if (!event.dataTransfer?.types.includes("Files")) return;
    event.preventDefault();
    upload(event.dataTransfer.files);
  });
}

/** The "Packages" control: the repository's packages, each with an
 * Install (src/packages.ts). One install at a time; progress and the
 * outcome land in the panel's own status line. */
function wirePackages(): void {
  const toggle = byId("packages-toggle") as HTMLButtonElement;
  const panel = byId("packages");
  const state = byId("packages-state");
  const list = byId("packages-list");
  // Its own line: the terminal's status is rewritten by the boot (Jupyter
  // starts after the shell), which would bury an install's outcome.
  const status = byId("packages-status");
  let catalog: Awaited<ReturnType<typeof loadCatalog>> | undefined;
  let busy = false;
  const install = async (name: string) => {
    if (packageInstall === undefined || busy) return;
    busy = true;
    panel.dataset.install = "running";
    for (const b of list.querySelectorAll("button")) b.disabled = true;
    try {
      const output = await packageInstall(
        name,
        (message) => status.textContent = message,
      );
      status.textContent = /^nothing to install$/m.test(output)
        ? `${name} is already installed`
        : `installed ${name}`;
      // Everything pkg installed with it (its dependencies) is installed too.
      const installed = new Set(
        [...output.matchAll(/^install (\S+) /gm)].map((match) => match[1]),
      );
      installed.add(name);
      for (const b of list.querySelectorAll<HTMLButtonElement>("button")) {
        if (installed.has(b.dataset.package ?? "")) b.textContent = "Installed";
      }
      panel.dataset.install = "done";
    } catch (error) {
      status.textContent = error instanceof Error
        ? error.message
        : String(error);
      panel.dataset.install = "failed";
    } finally {
      busy = false;
      for (const b of list.querySelectorAll("button")) {
        b.disabled = b.textContent === "Installed";
      }
    }
  };
  let loading = false;
  const show = async () => {
    if (catalog !== undefined || loading) return;
    loading = true;
    try {
      // Images before the modular base image have no `pkg` to install with.
      const yurt = (globalThis as unknown as { yurt: Yurt }).yurt;
      const image = await yurt.exec(
        `command -v pkg >/dev/null && command -v sudo >/dev/null && test -r ${TRUSTED_REPOS_PATH}`,
      );
      if (!("code" in image) || image.code !== 0) {
        state.textContent =
          "This sandbox's image has no pkg (or no sudo for it), so it cannot install packages.";
        return;
      }
      catalog = await loadCatalog();
    } catch (error) {
      state.textContent = `could not load the package list: ${
        error instanceof Error ? error.message : String(error)
      }`;
      return;
    } finally {
      loading = false;
    }
    state.hidden = true;
    for (const row of catalogRows(catalog)) {
      const tr = document.createElement("tr");
      const name = document.createElement("td");
      name.textContent = row.name;
      const version = document.createElement("td");
      version.textContent = row.version;
      const size = document.createElement("td");
      size.className = "size";
      size.textContent = formatBytes(row.size);
      const action = document.createElement("td");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "bar-action";
      button.textContent = "Install";
      button.dataset.package = row.name;
      button.addEventListener("click", () => install(row.name));
      action.append(button);
      tr.append(name, version, size, action);
      list.append(tr);
    }
  };
  toggle.addEventListener("click", () => {
    panel.hidden = !panel.hidden;
    toggle.setAttribute("aria-expanded", String(!panel.hidden));
    if (!panel.hidden) void show();
  });
}

async function runPage(): Promise<void> {
  watchNetwork(byId("net"));
  // One writer for #status: the boot's progress must not bury the outcome
  // of a Download home or an Upload (src/status_line.ts).
  const status = createStatusLine(byId("status"));
  wireExportHome(status);
  wireUpload(status);
  // The desktop app runs the sandbox natively; only the in-tab kernel needs
  // cross-origin isolation, and a page served without it cannot boot at all
  // and goes to the explanation.
  const desktop = await desktopInfo();
  // The page's own claim is about the tab; the desktop app's sandbox is on
  // this machine and on the network, and the header should say which.
  if (desktop !== undefined) {
    byId("lead").textContent =
      "A Linux sandbox running natively on this machine, shown in this tab, " +
      "with network access.";
    byId("offline-note").hidden = true;
  }
  if (desktop === undefined && globalThis.crossOriginIsolated !== true) {
    status.failure("need COOP/COEP");
    yurtState.failed("the page is not cross-origin isolated");
    globalThis.location.replace("./unsupported.html");
    throw new Error("not crossOriginIsolated");
  }
  // The cell is part of the workspace from the first screen, waiting for
  // the sandbox; its Run reaches the coordinator once there is one.
  const execute = { current: (_id: string, _code: string) => {} };
  const interruptCell = { current: (_id: string) => {} };
  const notebook = mountNotebook(
    byId("notebook"),
    (id, code) => execute.current(id, code),
    (id) => interruptCell.current(id),
  );
  // A tablet gets the Linux shell only. Jupyter (this cell, the Notebook and
  // JupyterLab pages) and the agent need more memory than a tablet browser
  // gives one tab: iPadOS refused new processes after ~13 while ipykernel
  // started. The desktop app runs natively and keeps everything.
  const device = deviceClass();
  const shellOnly = desktop === undefined && device === "tablet";
  // The panel's installs run in the coordinator, capped like the tab's
  // other installs (16 MiB on a phone or tablet: boot's `smallDevice`).
  wirePackages();
  // Only the in-tab kernel has the memory problem; the desktop app's page
  // runs the sandbox natively. A phone, and a tab the browser reloaded
  // mid-boot, get no sandbox unless `?start-anyway`. Read (and clear) the
  // boot memory either way, so `?start-anyway` does not leave it for the
  // next load.
  const cutOff = desktop === undefined ? cutOffBoot() : undefined;
  const refused = desktop === undefined &&
    !new URL(location.href).searchParams.has("start-anyway") &&
    (device === "phone" || cutOff !== undefined);
  const phone = device === "phone";
  // A phone that starts anyway boots the shell (and the agent) without
  // Python or Jupyter: the automatic Python install ran an iPhone tab out
  // of memory for new processes. The phone note and the cell say so.
  const noPython = shellOnly || (desktop === undefined && phone);
  if (shellOnly) {
    for (const id of ["notebook", "agent"]) byId(id).hidden = true;
    for (const testid of ["choose-notebook", "choose-lab"]) {
      const link = document.querySelector<HTMLElement>(
        `[data-testid=${testid}]`,
      );
      if (link) link.hidden = true;
    }
  } else {
    // The local agent (#140) drives the same sandbox through window.yurt; its
    // Run starts the sandbox the way the Start button does, and only then.
    // With the boot refused there is no sandbox to start, so the pane says
    // so instead of offering a Run that does nothing (#197).
    void mountAgentPane(byId("agent"), {
      yurt: () => (globalThis as unknown as { yurt: Yurt }).yurt,
      start: () => document.getElementById("start-sandbox")?.click(),
      unavailable: refused
        ? (phone ? "not on phones" : "no sandbox")
        : undefined,
    });
  }
  const start = document.getElementById("start");
  const begin = () => {
    if (start) start.hidden = true;
    // Two sandboxes in one browser share the CPU (yurt-playground#84): say
    // so before this one boots, and answer the next tab that asks. The
    // desktop app's sandbox is native and one per launcher, so neither
    // applies there.
    let stopWatchingForAnotherSandbox = () => {};
    if (desktop === undefined) {
      const note = byId("another-tab-note");
      stopWatchingForAnotherSandbox = watchForAnotherSandbox(
        () => note.hidden = false,
        () => note.hidden = true,
      );
      stopAnnouncing = announceSandbox();
    }
    boot(
      notebook,
      execute,
      interruptCell,
      desktop,
      stopWatchingForAnotherSandbox,
      noPython,
      status,
      device !== "desktop",
    );
  };
  if (desktop === undefined) {
    if (device === "tablet") byId("mobile-note").hidden = false;
    if (refused) {
      status.failure(phone ? "not on phones" : "failed");
      showFailure(phone ? "phone" : "reloaded", phone ? undefined : cutOff);
      notebook.unavailable(phone ? "not on phones" : "no sandbox");
      yurtState.failed(
        phone ? "not on phones" : `a previous boot was cut off at ${cutOff}`,
      );
      return;
    }
    if (phone) {
      byId("phone-note").hidden = false;
      notebook.unavailable("not on phones");
    }
  }
  // The boot memory has been read (and cleared) by now; a test that plants
  // one for the next load must wait for this, or this load consumes it.
  document.documentElement.dataset.settled = "";
  // Only a reload frees what the browser refused (yurtos-kernel#2996).
  byId(MEMORY_REFUSED_RELOAD_ID).addEventListener(
    "click",
    () => location.reload(),
  );
  // The workspace opens with one action; `?start` (the old terminal page's
  // redirect, and the acceptance tests) skips it.
  if (start === null || new URL(location.href).searchParams.has("start")) {
    begin();
    return;
  }
  byId("start-sandbox").addEventListener("click", begin, { once: true });
}

void runPage();
