/// <reference lib="deno.worker" />
/**
 * Coordinator for the suspend/resume notebook kernel (`yurt-snapshot` in
 * jupyterlite/yurt-kernel): one sealable CPython in the kernel, driven as a
 * Jupyter kernel from here.
 *
 * The guest is `python3-seal.wasm` — CPython relinked with Asyncify on
 * `yurt.syscall` (scripts/build-python-seal.sh) — running
 * `public/demo/cell_server.py`: it reads cells off its stdin and answers on
 * its stdout, one JSON frame per line, over a host pty in raw mode. This
 * worker speaks the Jupyter messaging protocol to the page (kernel_info,
 * execute_request → status/stream/execute_result/error/execute_reply) and
 * turns each execute_request into a frame for the guest. No ipykernel, no
 * ZMQ: the guest is one thread that is parked in read(2) between cells and
 * in write(2) whenever a cell prints, and either is a syscall the sandbox
 * seal can unwind it at.
 *
 * Suspend = `KernelHostInterface.sealSandbox` (the kernel's memory, with the
 * ramfs holding the staged Python stdlib, plus the guest's memory and its
 * unwound stack) written to IndexedDB, then the sandbox torn down. Resume =
 * `KernelHostInterface.restore` from that record: the guest re-issues the
 * syscall it was unwound at and carries on — mid-cell, into the same cell
 * output, because the cell's request header rides in the record too.
 *
 * Only the Python stdlib is staged from the playground image (`stagedPath`):
 * the ramfs lives in the kernel's memory and every staged byte is copied on
 * every seal. A classic Worker like the playground's coordinator: `WorkerHost`
 * parks on `Atomics.wait`, which the window thread may not do.
 */
import {
  defaultHostState,
  KernelHostInterface,
  pumpPtyMaster,
  s,
  type SandboxSealImage,
  type UserProcess,
} from "@yurt/kernel-host-interface-js";
import { fetchPlaygroundBytes } from "./boot.ts";
import { partsFetch, PYTHON_SEAL_NAME } from "./image_parts.ts";
import type { JupyterHeader, JupyterMessage } from "./jupyter_protocol.ts";
import type {
  JupyterChannel,
  JupyterRequestChannel,
} from "./jupyter_transport.ts";
import { installCoordinatorWorkerProxy } from "./page_worker_bridge.ts";
import {
  clearSnapshot,
  loadSnapshot,
  NOTEBOOK_KEY,
  sha256Hex,
  type StoredSnapshot,
  storeSnapshot,
} from "./snapshot_store.ts";
import { stagedPath } from "./notebook_stage.ts";
import { stageYurtimg, writeRamfsFile } from "./stage.ts";
import { announceSandbox, anotherSandboxRunning } from "./tab_presence.ts";

installCoordinatorWorkerProxy();

const GUEST_PATH = `./${PYTHON_SEAL_NAME}`;
const CELL_SERVER_PATH = "./demo/cell_server.py";
const CELL_SERVER_GUEST_PATH = "/usr/local/yurt/cell_server.py";
const SIGINT = 2;
const SIGKILL = 9;
/** A cell that makes no syscall for this long cannot be sealed: the seal
 *  lands at the guest's next syscall, and a pure compute loop never makes
 *  one. Printing progress is what makes a long cell suspendable. */
const SEAL_DEADLINE_MS = 15_000;
const PROTOCOL_VERSION = "5.3";
/** Its own presence channel: the home page's sandbox may run alongside. */
const PRESENCE_CHANNEL = "yurt-notebook-snapshot";

export type NotebookKernelToWorker =
  | { type: "start"; isolated: boolean }
  | {
    type: "jupyter-send";
    message: JupyterMessage;
    channel: JupyterRequestChannel;
  }
  | { type: "jupyter-restart" }
  /** Seal, store, and tear the sandbox down. */
  | { type: "suspend" }
  /** Bring the stored sandbox back. */
  | { type: "resume" }
  /** Drop the stored image (the next start boots fresh). */
  | { type: "forget" };

export type SnapshotState =
  | { state: "booting" }
  | { state: "running"; restoredFrom?: number }
  | { state: "sealing" }
  | { state: "suspended"; sealedAt: number; bytes: number; ms: number }
  | { state: "resuming" };

export type NotebookKernelFromWorker =
  | { type: "status"; text: string }
  | { type: "error"; message: string }
  | { type: "notebook-ready" }
  | { type: "jupyter-restarted" }
  | {
    type: "jupyter-message";
    message: JupyterMessage;
    channel: JupyterChannel;
  }
  | { type: "snapshot"; snapshot: SnapshotState };

function post(message: NotebookKernelFromWorker): void {
  self.postMessage(message);
}

function status(text: string): void {
  post({ type: "status", text });
}

function imageBytes(image: SandboxSealImage): number {
  return image.kernelMemory.byteLength +
    image.processes.reduce(
      (sum, process) => sum + process.snapshot.memoryBytes.byteLength,
      0,
    );
}

// ── The Jupyter side ────────────────────────────────────────────────────

type ExecuteRequest = {
  header: JupyterHeader;
  code: string;
  silent: boolean;
  storeHistory: boolean;
};

/** What a seal has to carry for the cells to continue where they were. */
type CellState = {
  executionCount: number;
  /** The cell the guest is running, if any. */
  current: ExecuteRequest | undefined;
  /** Cells queued behind it, in order. */
  queued: ExecuteRequest[];
  /** The tail of the guest's output that has no newline yet. */
  partialLine: string;
};

const cells: CellState = {
  executionCount: 0,
  current: undefined,
  queued: [],
  partialLine: "",
};

function header(parent: JupyterHeader, msgType: string): JupyterHeader {
  return {
    msg_id: crypto.randomUUID(),
    username: "kernel",
    session: parent.session,
    msg_type: msgType,
    version: PROTOCOL_VERSION,
    date: new Date().toISOString(),
  };
}

function send(
  parent: JupyterHeader,
  channel: JupyterChannel,
  msgType: string,
  content: Record<string, unknown>,
): void {
  post({
    type: "jupyter-message",
    channel,
    message: {
      header: header(parent, msgType),
      parent_header: parent,
      metadata: {},
      content,
    },
  });
}

function publishStatus(parent: JupyterHeader, state: "busy" | "idle"): void {
  send(parent, "iopub", "status", { execution_state: state });
}

const KERNEL_INFO = {
  status: "ok",
  protocol_version: PROTOCOL_VERSION,
  implementation: "yurt-snapshot",
  implementation_version: "0.1.0",
  language_info: {
    name: "python",
    version: "3.14",
    mimetype: "text/x-python",
    file_extension: ".py",
    pygments_lexer: "ipython3",
    codemirror_mode: { name: "python", version: 3 },
    nbconvert_exporter: "python",
  },
  banner: "Python 3 in a Yurt sandbox that can be suspended and resumed",
  help_links: [],
};

/** Answer a shell/control request the guest is not involved in. */
function answerLocally(
  message: JupyterMessage,
  channel: JupyterRequestChannel,
): boolean {
  const parent = message.header;
  const type = parent.msg_type;
  const reply = (content: Record<string, unknown>) => {
    publishStatus(parent, "busy");
    send(parent, channel, type.replace(/_request$/, "_reply"), content);
    publishStatus(parent, "idle");
  };
  switch (type) {
    case "kernel_info_request":
      reply(KERNEL_INFO);
      return true;
    case "comm_info_request":
      reply({ status: "ok", comms: {} });
      return true;
    case "history_request":
      reply({ status: "ok", history: [] });
      return true;
    case "is_complete_request":
      reply({ status: "complete" });
      return true;
    case "complete_request": {
      const cursor = Number(message.content.cursor_pos ?? 0);
      reply({
        status: "ok",
        matches: [],
        cursor_start: cursor,
        cursor_end: cursor,
        metadata: {},
      });
      return true;
    }
    case "inspect_request":
      reply({ status: "ok", found: false, data: {}, metadata: {} });
      return true;
    case "shutdown_request":
      reply({ status: "ok", restart: message.content.restart === true });
      return true;
    case "interrupt_request":
      // The guest is one process: SIGINT raises KeyboardInterrupt in the
      // cell, which answers with an error frame like any other.
      if (live !== undefined && cells.current !== undefined) {
        try {
          live.mk.killProcess(live.process.pid, SIGINT);
        } catch { /* the guest is gone; its exit is reported elsewhere */ }
      }
      reply({ status: "ok" });
      return true;
    case "execute_request":
      return false;
    default:
      if (type.endsWith("_request")) {
        reply({ status: "ok" });
        return true;
      }
      return true;
  }
}

function enqueueExecute(message: JupyterMessage): void {
  cells.queued.push({
    header: message.header,
    code: String(message.content.code ?? ""),
    silent: message.content.silent === true,
    storeHistory: message.content.store_history !== false,
  });
  runNextCell();
}

/** Hand the guest the next queued cell, when it is idle and we are live. */
function runNextCell(): void {
  if (live === undefined || cells.current !== undefined) return;
  const next = cells.queued.shift();
  if (next === undefined) return;
  cells.current = next;
  publishStatus(next.header, "busy");
  if (!next.silent && next.storeHistory) {
    send(next.header, "iopub", "execute_input", {
      code: next.code,
      execution_count: cells.executionCount + 1,
    });
  }
  const frame = JSON.stringify({ t: "exec", code: next.code }) + "\n";
  try {
    live.mk.ptyMasterWrite(live.pty, new TextEncoder().encode(frame));
  } catch (error) {
    finishCell({
      t: "error",
      ename: "KernelGone",
      evalue: `the guest could not be reached: ${
        error instanceof Error ? error.message : String(error)
      }`,
      traceback: [],
    });
    finishCell({ t: "done", count: cells.executionCount + 1 });
  }
}

type GuestFrame =
  | { t: "ready" }
  | { t: "stream"; name: "stdout" | "stderr"; text: string }
  | { t: "result"; text: string }
  | { t: "error"; ename: string; evalue: string; traceback: string[] }
  | { t: "done"; count: number };

let lastError:
  | { ename: string; evalue: string; traceback: string[] }
  | undefined;

/** One frame from the guest: `ready` is the sandbox side's, the rest belong
 *  to the cell in progress. */
function handleFrame(frame: GuestFrame): void {
  if (frame.t === "ready") {
    // A fresh guest (boot or restart); a restored one never says it again.
    for (const waiter of [...readyWaiters]) waiter();
    return;
  }
  finishCell(frame);
}

function finishCell(frame: Exclude<GuestFrame, { t: "ready" }>): void {
  const current = cells.current;
  if (current === undefined) return;
  const parent = current.header;
  switch (frame.t) {
    case "stream":
      if (!current.silent) {
        send(parent, "iopub", "stream", { name: frame.name, text: frame.text });
      }
      return;
    case "result":
      if (!current.silent) {
        send(parent, "iopub", "execute_result", {
          execution_count: cells.executionCount + 1,
          data: { "text/plain": frame.text },
          metadata: {},
        });
      }
      return;
    case "error":
      lastError = frame;
      if (!current.silent) {
        send(parent, "iopub", "error", {
          ename: frame.ename,
          evalue: frame.evalue,
          traceback: frame.traceback,
        });
      }
      return;
    case "done": {
      cells.executionCount = frame.count;
      const error = lastError;
      lastError = undefined;
      send(parent, "shell", "execute_reply", {
        status: error === undefined ? "ok" : "error",
        execution_count: frame.count,
        user_expressions: {},
        payload: [],
        ...(error ?? {}),
      });
      publishStatus(parent, "idle");
      cells.current = undefined;
      runNextCell();
      return;
    }
  }
}

/** Guest output arrives as pty bytes; frames are whole lines. */
function onGuestOutput(bytes: Uint8Array): void {
  cells.partialLine += new TextDecoder().decode(bytes);
  let newline = cells.partialLine.indexOf("\n");
  while (newline !== -1) {
    const line = cells.partialLine.slice(0, newline);
    cells.partialLine = cells.partialLine.slice(newline + 1);
    newline = cells.partialLine.indexOf("\n");
    if (line.trim() === "") continue;
    let frame: GuestFrame;
    try {
      frame = JSON.parse(line);
      if (typeof frame !== "object" || frame === null || !("t" in frame)) {
        throw new Error("not a frame");
      }
    } catch {
      // Not a frame: something wrote to the pty around the protocol (a
      // Python warning at startup); show it rather than lose it.
      if (cells.current !== undefined) {
        finishCell({ t: "stream", name: "stderr", text: line + "\n" });
      } else {
        status(line);
      }
      continue;
    }
    handleFrame(frame);
  }
}

/** Every cell in flight fails: the guest is being replaced. */
function failAllCells(reason: string): void {
  const inFlight = cells.current === undefined
    ? cells.queued
    : [cells.current, ...cells.queued];
  cells.current = undefined;
  cells.queued = [];
  cells.partialLine = "";
  lastError = undefined;
  for (const cell of inFlight) {
    send(cell.header, "shell", "execute_reply", {
      status: "error",
      execution_count: cells.executionCount,
      ename: "KernelRestarted",
      evalue: reason,
      traceback: [],
      user_expressions: {},
      payload: [],
    });
    publishStatus(cell.header, "idle");
  }
}

// ── The sandbox side ────────────────────────────────────────────────────

type Live = {
  mk: KernelHostInterface;
  pty: number;
  process: UserProcess;
  stopPump: () => void;
  kernelSha256: string;
};

let live: Live | undefined;
let kernelBytes: Uint8Array | undefined;
let guestBytes: Uint8Array | undefined;
let cellServer: Uint8Array | undefined;
let sealing = false;
let started = false;

async function fetchDemoFile(
  path: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Uint8Array> {
  const response = await fetchImpl(path);
  if (!response.ok) {
    throw new Error(`fetch ${path} failed: ${response.status}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

function attachGuest(
  mk: KernelHostInterface,
  pty: number,
  process: UserProcess,
): () => void {
  const stopPump = pumpPtyMaster(mk, pty, onGuestOutput);
  process.runStartAsync().then(
    (code) => {
      if (live?.process !== process) return;
      status(`the Python process exited with ${code}`);
      failAllCells(`the kernel's Python process exited with ${code}`);
    },
    (error) => {
      if (live?.process !== process) return;
      const reason = error instanceof Error ? error.message : String(error);
      status(`the Python process failed: ${reason}`);
      failAllCells(`the kernel's Python process failed: ${reason}`);
    },
  );
  return stopPump;
}

/** Spawn the cell server in `mk`; resolves once it has said `ready`. */
async function spawnCellServer(
  mk: KernelHostInterface,
): Promise<{ process: UserProcess; pty: number; stopPump: () => void }> {
  if (guestBytes === undefined) {
    status("loading Python");
    // Published in parts like the image (Cloudflare Pages' 25 MiB cap).
    guestBytes = await fetchDemoFile(GUEST_PATH, partsFetch());
  }
  status("starting Python");
  const process = await mk.spawnUserProcessWithArgsAsync(guestBytes, [
    s("python3"),
    s(CELL_SERVER_GUEST_PATH),
  ], {
    PYTHONHOME: "/usr/local",
    // The staged stdlib has no __pycache__ and the ramfs is imaged on every
    // seal; compile at import rather than grow the image with .pyc files.
    PYTHONDONTWRITEBYTECODE: "1",
    HOME: "/root",
    PATH: "/usr/local/bin:/bin",
    TERM: "dumb",
  });
  const pty = mk.attachHostPty(process.pid);
  const ready = new Promise<void>((resolve, reject) => {
    const seen = () => {
      readyWaiters.delete(seen);
      resolve();
    };
    readyWaiters.add(seen);
    process.runStartAsync().then(
      (code) => reject(new Error(`Python exited ${code} before it was ready`)),
      (error) => reject(error),
    );
  });
  const stopPump = attachGuest(mk, pty, process);
  await ready;
  return { process, pty, stopPump };
}

/** Resolved by the guest's `ready` frame (`spawnCellServer`). */
const readyWaiters = new Set<() => void>();

async function bootFresh(
  kernel: Uint8Array,
  kernelSha256: string,
): Promise<Live> {
  status("booting the kernel");
  const mk = await KernelHostInterface.load(kernel, defaultHostState());
  status("loading the image");
  const image = await fetchPlaygroundBytes("./playground.yurtimg");
  status("staging the Python stdlib");
  await stageYurtimg(mk, image, new Map(), stagedPath);
  if (cellServer === undefined) {
    cellServer = await fetchDemoFile(CELL_SERVER_PATH);
  }
  writeRamfsFile(mk, CELL_SERVER_GUEST_PATH, cellServer);
  const { process, pty, stopPump } = await spawnCellServer(mk);
  return { mk, pty, process, stopPump, kernelSha256 };
}

async function restoreStored(
  kernel: Uint8Array,
  stored: StoredSnapshot,
): Promise<Live> {
  const restored = await KernelHostInterface.restore(
    kernel,
    stored.image,
    defaultHostState(),
  );
  try {
    const [process] = restored.processes;
    if (process === undefined) throw new Error("the image holds no process");
    const saved = stored.attachments?.cells as CellState | undefined;
    if (saved !== undefined) {
      cells.executionCount = saved.executionCount;
      cells.current = saved.current;
      cells.queued = saved.queued;
      cells.partialLine = saved.partialLine;
    }
    const stopPump = attachGuest(restored.host, stored.pty, process);
    return {
      mk: restored.host,
      pty: stored.pty,
      process,
      stopPump,
      kernelSha256: stored.kernelSha256,
    };
  } catch (error) {
    for (const process of restored.processes) {
      try {
        restored.host.killProcess(process.pid, SIGKILL);
      } catch { /* already gone */ }
    }
    restored.host.dispose();
    throw error;
  }
}

function teardown(current: Live): void {
  current.stopPump();
  try {
    current.mk.killProcess(current.process.pid, SIGKILL);
  } catch { /* already gone */ }
  current.mk.dispose();
}

async function suspend(): Promise<void> {
  const current = live;
  if (current === undefined || sealing) return;
  sealing = true;
  post({ type: "snapshot", snapshot: { state: "sealing" } });
  const startedAt = performance.now();
  try {
    const image = await current.mk.sealSandbox({
      deadlineMs: SEAL_DEADLINE_MS,
    });
    const sealedAt = Date.now();
    await storeSnapshot({
      image,
      pty: current.pty,
      sealedAt,
      kernelSha256: current.kernelSha256,
      attachments: { cells: structuredClone(cells) },
    }, NOTEBOOK_KEY);
    live = undefined;
    teardown(current);
    post({
      type: "snapshot",
      snapshot: {
        state: "suspended",
        sealedAt,
        bytes: imageBytes(image),
        ms: Math.round(performance.now() - startedAt),
      },
    });
  } catch (error) {
    status(
      `suspend failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    post({ type: "snapshot", snapshot: { state: "running" } });
  } finally {
    sealing = false;
  }
}

async function resume(): Promise<void> {
  if (live !== undefined || kernelBytes === undefined) return;
  const stored = await loadSnapshot(NOTEBOOK_KEY);
  if (stored === undefined) {
    status("nothing to resume: no stored image");
    return;
  }
  post({ type: "snapshot", snapshot: { state: "resuming" } });
  try {
    live = await restoreStored(kernelBytes, stored);
    post({
      type: "snapshot",
      snapshot: { state: "running", restoredFrom: stored.sealedAt },
    });
    // A cell queued while the guest was mid-cell waits for that cell; one
    // queued while the guest was idle starts now.
    runNextCell();
  } catch (error) {
    post({
      type: "error",
      message: `resume failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    });
  }
}

async function restart(): Promise<void> {
  const current = live;
  if (current === undefined) return;
  failAllCells("Kernel restarted before the request completed");
  current.stopPump();
  try {
    current.mk.killProcess(current.process.pid, SIGKILL);
  } catch { /* already gone */ }
  try {
    const { process, pty, stopPump } = await spawnCellServer(current.mk);
    live = { ...current, process, pty, stopPump };
    cells.executionCount = 0;
    post({ type: "jupyter-restarted" });
  } catch (error) {
    post({
      type: "error",
      message: `restart failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    });
  }
}

async function start(isolated: boolean): Promise<void> {
  if (started) return;
  started = true;
  if (!isolated) throw new Error("not crossOriginIsolated");
  if (await anotherSandboxRunning(300, PRESENCE_CHANNEL)) {
    throw new Error("this notebook kernel is already running in another tab");
  }
  announceSandbox(PRESENCE_CHANNEL);
  post({ type: "snapshot", snapshot: { state: "booting" } });
  status("loading kernel");
  kernelBytes = await fetchPlaygroundBytes("./yurt_kernel.wasm");
  const kernelSha256 = await sha256Hex(kernelBytes);
  let stored = await loadSnapshot(NOTEBOOK_KEY);
  if (stored !== undefined && stored.kernelSha256 !== kernelSha256) {
    await clearSnapshot(NOTEBOOK_KEY);
    status(
      "stored image was sealed under a different kernel build; booting fresh",
    );
    stored = undefined;
  }
  if (stored !== undefined) {
    status("restoring the suspended kernel");
    try {
      live = await restoreStored(kernelBytes, stored);
      post({
        type: "snapshot",
        snapshot: { state: "running", restoredFrom: stored.sealedAt },
      });
      post({ type: "notebook-ready" });
      return;
    } catch (error) {
      await clearSnapshot(NOTEBOOK_KEY);
      status(
        `stored image could not be restored (${
          error instanceof Error ? error.message : String(error)
        }); booting fresh`,
      );
    }
  }
  live = await bootFresh(kernelBytes, kernelSha256);
  post({ type: "snapshot", snapshot: { state: "running" } });
  post({ type: "notebook-ready" });
}

self.onmessage = async (event: MessageEvent<NotebookKernelToWorker>) => {
  const msg = event.data;
  try {
    switch (msg.type) {
      case "start":
        await start(msg.isolated);
        return;
      case "jupyter-send":
        if (!answerLocally(msg.message, msg.channel)) {
          enqueueExecute(msg.message);
        }
        return;
      case "jupyter-restart":
        await restart();
        return;
      case "suspend":
        await suspend();
        return;
      case "resume":
        await resume();
        return;
      case "forget":
        await clearSnapshot(NOTEBOOK_KEY);
        status("stored image dropped");
        return;
    }
  } catch (error) {
    post({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
