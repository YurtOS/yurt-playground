/// <reference lib="deno.worker" />
/**
 * Browser coordinator. WorkerHost.spawnRootLeader uses Atomics.wait, which
 * is legal here and illegal on the window thread.
 */
import {
  bootPlayground,
  browserImagePath,
  fetchPlaygroundBytes,
  playgroundPins,
  type PlaygroundTerm,
  SLIM_IMAGE_PATH,
} from "./boot.ts";
import {
  executeCell,
  type JupyterStream,
  type KernelPorts,
  relaunchNote,
  restartGuestKernel,
  startGuestKernel,
} from "./jupyter.ts";
import { requestCellInterrupt } from "./cell_interrupt.ts";
import {
  installThenLaunch,
  kernelFailureDropsLayer,
  kernelLifecycle,
  probePython,
  restoresSnapshot,
  type StartReport,
  startSandbox,
} from "./coordinator_start.ts";
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
import {
  type InstalledRelease,
  installedReleases,
  type InstalledReport,
  installedReporter,
} from "./installed_list.ts";
import {
  browserArchiveCache,
  installPackage,
  InstallStalled,
  stalledSandboxWhy,
} from "./packages.ts";
import {
  browserLayerStore,
  installWithLayer,
  LayerFailed,
  layerKey,
  type LayerStore,
} from "./python_layer.ts";
import { liveAnswers } from "./python_install.ts";
import {
  capturePrecompiles,
  captureWarmsGo,
  goWarmupLine,
  postCaptured,
  precompileLine,
} from "./capture_outcome.ts";
import { playgroundGuestPortIsDirect } from "./guest_port_policy.ts";
import { ensureGo, GO_PROBE_LINE } from "./go_fallback.ts";
import {
  encodeSandboxSnapshot,
  SNAPSHOT_KINDS,
  snapshotIdentity,
  type SnapshotKind,
} from "./sandbox_snapshot.ts";
import { linuxRemark } from "./linux_remark.ts";
import { baseToolsIn } from "./image_tools.ts";
import {
  isUploadedSnapshotId,
  uploadedSnapshotPath,
} from "./snapshot_source.ts";
import { runQueue } from "./run_queue.ts";
import { type BootedSession, workerPackageHost } from "./session_packages.ts";
import {
  type MemoryRefusedMessage,
  memoryRefusedMessage,
} from "./memory_refused.ts";

installCoordinatorWorkerProxy(() => playgroundGuestPortIsDirect());
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
    // A tablet gets the shell only: ipykernel's memory is what a tablet
    // browser refuses first (iPadOS stopped spawning after ~13 processes
    // while Jupyter started), so it is never launched there.
    noJupyter?: boolean;
    // The slim image: the Python set to install when the image lacks it
    // (src/coordinator_start.ts), before ipykernel -- the newest complete
    // one in the live signed index, or the one at the build of the python
    // the image ships (src/python_install.ts). Absent, such an image is
    // reported as `python-missing`, as before.
    python?: PythonRequest;
    // A tablet or phone: installs over 16 MiB are refused there.
    tablet?: boolean;
    // `?snapshot=1`: restore the sealed sandbox (src/sandbox_snapshot.ts)
    // instead of booting the image; `?snapshot=capture`: boot and install
    // as usual, then seal instead of starting Jupyter and hand the file
    // to the page (`snapshot-captured`).
    snapshot?: "restore" | "capture";
    // `?snapshot=<id>`: the uploaded snapshot to restore instead of the
    // pinned one (src/snapshot_source.ts); with `snapshot: "restore"`.
    snapshotId?: string;
    // `?snapshot=capture&packages=a,b`: packages a capture installs after
    // the Python set, before it seals (scripts/snapshot-local.ts).
    capturePackages?: string[];
    // Which snapshot (src/snapshot_pin.ts SNAPSHOT_KINDS): the one a
    // restore takes (the device's), or the one a capture makes. The
    // phone's capture comes with no `python` request (the image as it
    // boots); the tablet's with python alone; the desktop's with the set.
    snapshotKind?: SnapshotKind;
    // A restore's Python, when the page installs none itself: what the
    // live index is asked about for the snapshot's check (a tablet's
    // python alone). `python` takes its place when there is one.
    snapshotPython?: PythonRequest;
    // Go's page (src/go_fallback.ts): the go package to install when the
    // sandbox has no go -- Go's snapshot could not be restored and the
    // slim image was booted instead.
    goFallback?: PythonRequest;
  }
  // Install Python again after a failed install (the cell's Install), then
  // start the kernel. Answered like a boot: status, then notebook-ready or
  // python-missing.
  | { type: "python-install" }
  | { type: "in"; text: string }
  | { type: "resize"; rows: number; cols: number }
  | { type: "cell"; id: string; code: string }
  // Stop whatever the kernel is running: KeyboardInterrupt in the cell,
  // which then answers with its traceback like any other error (#130).
  | { type: "cell-interrupt"; id: string }
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
  | { type: "yurt-list"; req: number }
  // The Packages panel's install of one package (src/packages.ts), run
  // here like the automatic Python install and queued with it: one
  // install at a time. Progress comes back as `pkg-progress`.
  | { type: "pkg-install"; req: number; name: string; tablet: boolean }
  // The Packages panel opened: what pkg has installed, as `pkg-installed`.
  | { type: "pkg-read-installed" };

type FromWorker =
  // status, error, shell-ready (the shell is the whole session), and
  // python-missing / notebook-ready (src/coordinator_start.ts).
  | StartReport
  // The browser refused a new process its memory (src/memory_refused.ts).
  | MemoryRefusedMessage
  | { type: "out"; bytes: number[] }
  | {
    type: "cell-result";
    id: string;
    result: Awaited<ReturnType<typeof executeCell>>;
  }
  // What the running cell has printed so far, so the pane is not blank for
  // the whole of a slow one (#131). The result carries the same text again.
  | {
    type: "cell-stream";
    id: string;
    chunk: JupyterStream;
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
  }
  | { type: "pkg-progress"; req: number; text: string }
  // What pkg has installed (src/installed_list.ts), or why that cannot be
  // told: the Packages panel marks those Installed.
  | InstalledReport
  | { type: "snapshot-captured"; blob: Blob; ms: number }
  // What this Linux holds (src/linux_remark.ts), as the shell starts.
  | { type: "linux-remark"; remark: string }
  | {
    type: "pkg-reply";
    req: number;
    ok: boolean;
    value?: string;
    error?: string;
  };

let jupyter: JupyterTransport | undefined;
let launchSession: Awaited<ReturnType<typeof bootPlayground>> | undefined;
let executions: ExecutionRegistry | undefined;
/** The booted session, the desktop app's too. Only the in-tab one installs
 * packages (it has `writeFiles`) and reads pkg's installed list (`files`). */
let packageSession: Awaited<ReturnType<typeof bootPlayground>> | undefined;

async function servePackages(msg: ToWorker): Promise<void> {
  if (msg.type !== "pkg-install") return;
  const { req } = msg;
  /** The sandbox this install ran in. */
  let used: typeof packageSession;
  try {
    // The session as it is when this install's turn comes: one queued
    // behind a stalled install may find a fresh sandbox, or a stalled one.
    const output = await installs(() => {
      const session = packageSession;
      used = session;
      if (session?.process === undefined || session.writeFiles === undefined) {
        throw new Error("this sandbox does not install packages");
      }
      if (sandboxStalled) throw new Error(stalledSandbox());
      pkgTouched.add(session);
      return installPackage(msg.name, {
        host: workerPackageHost(session),
        tablet: msg.tablet,
        progress: (text) => post({ type: "pkg-progress", req, text }),
        // As the terminal installs: one repository cache for both.
        relayed: session.pkgRelay === true,
      });
    });
    post({ type: "pkg-reply", req, ok: true, value: output });
  } catch (error) {
    let said = error instanceof Error ? error.message : String(error);
    // Only if it is still the sandbox: a recovery can end after Try again
    // has dropped it for a fresh one, which this stall says nothing about.
    if (
      error instanceof InstallStalled && error.inSandbox &&
      used === packageSession
    ) {
      sandboxStalled = true;
      stalledWhy = stalledSandboxWhy(error);
      // The panel shows this as it is: say the way to a fresh sandbox.
      said += "; reload the page for a fresh one";
    } else if (error instanceof InstallStalled && error.inSandbox) {
      // Its sandbox was dropped meanwhile: the one in use is fresh.
      said += "; that sandbox has since been replaced by a fresh one";
    }
    post({ type: "pkg-reply", req, ok: false, error: said });
  } finally {
    await installed.read();
  }
}

/** What pkg has installed in the in-tab sandbox, told to the page
 * (src/installed_list.ts). The desktop app's session has no `files`: its
 * page has no Packages panel to mark. */
const installed = installedReporter(
  (report) => {
    post(report);
    // What this Linux holds follows what pkg now lists (src/linux_remark.ts).
    if ("names" in report) packageSession?.refreshRemark?.();
  },
  () => packageSession?.files,
);

/** One install at a time, whole: an install is a plan run, the downloads
 * and an install run, every run stages at the same directory, and pkg
 * takes one lock. The Packages panel's installs and the automatic Python
 * install wait their turn here, so neither lands between the other's two
 * runs. */
const installs = runQueue();

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
/** The image has no Python set (src/coordinator_start.ts): a restart the
 * frontend asks for gets the same answer, not "Jupyter is not ready". */
let pythonMissing = false;
/** Restarts and installs run one at a time; a restart during the boot's
 * start is refused. */
const lifecycle = kernelLifecycle();
/** How the start installs Python on the slim image, kept for a retry. */
let installPython:
  | ((session: BootedSession) => Promise<void>)
  | undefined;
/** An install stopped making progress in this sandbox's `pkg` run
 * (src/packages.ts `InstallStalled`): it may no longer answer, and, unless
 * `pkg recover` finished it, its packages may be half applied. The Python install's next try is in a fresh
 * sandbox; the Packages panel installs nothing more into this one. */
let sandboxStalled = false;
/** Why the sandbox takes no more installs (set with `sandboxStalled`). */
let stalledWhy = "an earlier install stopped making progress";
const stalledSandbox = () =>
  `${stalledWhy} in this sandbox, so it installs nothing more; ` +
  "reload the page for a fresh one";
/** The sandboxes any package install was tried in, Python's or the
 * Packages panel's (src/python_layer.ts: a layer is used or kept only in a
 * sandbox with none before). */
const pkgTouched = new WeakSet<object>();
/** The layer store, when this sandbox's Python came from its layer: a
 * kernel that then does not start drops the layer, rather than every
 * later visit failing the same way. */
let layerInstalled: LayerStore | undefined;
/** A Jupyter that did not start on a layer's Python: drop the layer. */
function dropLayerIfKernelFailed(report: StartReport): void {
  if (layerInstalled !== undefined && kernelFailureDropsLayer(report)) {
    void layerInstalled.drop();
    layerInstalled = undefined;
  }
}

type PythonRequest = {
  label: string;
  set: string[];
  image?: string;
  installed?: InstalledRelease[];
};

/** `?snapshot=capture`: precompile the installed Python set, seal the
 * sandbox (no process left in it) and hand the snapshot file to the page,
 * in the kernel's place: a sealed sandbox runs nothing more. */
async function captureSnapshot(
  session: Awaited<ReturnType<typeof bootPlayground>>,
  /** The Python set the capture installed, as a layer key; null for the
   * phone's capture, which installs none. */
  pythonSet: string | null,
  /** Packages to install after the Python set, before the seal
   * (`?snapshot=capture&packages=`): in the snapshot's memory only, so a
   * restore's checks are the Python set's alone. */
  packages: readonly string[],
  kind: SnapshotKind,
): Promise<void> {
  if (session.seal === undefined || session.process === undefined) {
    throw new Error("this session cannot seal");
  }
  for (const name of packages) {
    // As the Packages panel installs one: in the install queue's turn.
    await installs(() => {
      pkgTouched.add(session);
      return installPackage(name, {
        host: workerPackageHost(session),
        tablet: false,
        progress: (text) => post({ type: "status", text }),
      });
    });
  }
  if (packages.length > 0) await installed.read();
  // The phone's snapshot holds no Python to compile, nor Go's
  // (capturePrecompiles).
  if (capturePrecompiles(kind)) {
    // Bytecode for every module the packages ship as source only
    // (PRECOMPILE_PROGRAM): each start compiled them again, slow on Safari,
    // where compiling one of wcwidth's modules also overflowed the Worker's
    // stack and killed ipykernel with SIGSEGV. Its failure is refused, with
    // its own words.
    await captureStep(
      session.process,
      precompileLine(),
      "precompiling Python modules",
      "precompiling the Python set",
      "precompiled",
    );
  }
  // Go's standard library compiled into the login user's build cache
  // (goWarmupScript): a cold first `go run` compiles it, ~17 min in a
  // tab, and the snapshot's restore then only compiles the user's own
  // package. Refused like the precompile when it fails.
  if (captureWarmsGo(kind)) {
    await captureStep(
      session.process,
      goWarmupLine(),
      "compiling Go's standard library into the build cache (minutes)",
      "warming Go's build cache",
      "warmed Go's build cache",
    );
  }
  // What it holds, for its pin and for people: pkg's list as the seal
  // keeps it (src/linux_remark.ts).
  const packagesHeld = await installedReleases(session.files) ?? [];
  const toolsHeld = await baseToolsIn(session.files);
  const contents = {
    packages: packagesHeld,
    remark: linuxRemark(packagesHeld, toolsHeld),
  };
  post({ type: "status", text: "sealing the sandbox" });
  const started = performance.now();
  const image = await session.seal();
  const blob = await encodeSandboxSnapshot(
    image,
    { ...snapshotIdentity(await playgroundPins()), pythonSet },
    contents,
  );
  postCaptured(post, blob, Math.round(performance.now() - started));
}

/** One of a capture's steps before the seal: run `line` (as the login
 * user, or root through sudo), say `status` meanwhile, and refuse the
 * capture with the step's own words unless it exits 0. */
async function captureStep(
  spawn: NonNullable<
    Awaited<ReturnType<typeof bootPlayground>>["process"]
  >,
  line: string,
  status: string,
  what: string,
  done: string,
): Promise<void> {
  post({ type: "status", text: status });
  const started = performance.now();
  const step = await spawn(line, { maxOutputBytes: 64 * 1024 });
  const exited = await step.exited;
  const code = typeof exited === "number" ? exited : exited.code;
  if (code !== 0) {
    const decoder = new TextDecoder();
    const said = decoder.decode(step.takeStdout()) +
      decoder.decode(step.takeStderr());
    throw new Error(
      `${what} exited ${JSON.stringify(exited)}: ${said.slice(-2000)}`,
    );
  }
  console.log(
    `[snapshot] ${done} in ${Math.round(performance.now() - started)} ms`,
  );
}

/** Drop the in-tab sandbox and start a fresh one the way the page's start
 * did: boot, then the Python install, then Jupyter. Set by `start`. */
let startFresh: (() => Promise<void>) | undefined;

/** Install Python again, then start the kernel (`python-install`, or a
 * frontend restart while Python is missing). After a stalled install, in
 * a fresh sandbox: the stalled one may not answer. */
async function retryPython(): Promise<void> {
  // Also when there is no sandbox: a fresh one whose boot failed is tried
  // again, rather than "Python is missing" with nothing to install into.
  if (
    (sandboxStalled || packageSession === undefined) &&
    startFresh !== undefined
  ) {
    await startFresh();
    return;
  }
  const session = packageSession;
  if (session === undefined || installPython === undefined) {
    post({ type: "python-missing" });
    return;
  }
  const started = await installThenLaunch(session, {
    installPython,
    launching: (s) => launchSession = s,
    startKernel: (s, relaunching) =>
      startGuestKernel(s, kernelPorts, { relaunching }),
    post: (report) => {
      pythonMissing = report.type === "python-missing";
      dropLayerIfKernelFailed(report);
      post(report);
    },
  });
  if (started !== undefined) {
    pythonMissing = false;
    jupyter = started;
    subscribeJupyter(jupyter);
  }
}

function subscribeJupyter(transport: JupyterTransport): void {
  transport.subscribe((message, channel) => {
    post({ type: "jupyter-message", message, channel });
  });
}

function post(msg: FromWorker): void {
  self.postMessage(msg);
}

/** The worker's terminal; `dropHandlers` forgets every session's handlers,
 * so a disposed session's (which hold its kernel) can be let go. */
function workerTerm(
  init: { cols: number; rows: number },
): PlaygroundTerm & { dropHandlers(): void } {
  const dataHandlers: Array<(data: string) => void> = [];
  const resizeHandlers: Array<
    (size: { rows: number; cols: number }) => void
  > = [];
  const term: PlaygroundTerm & { dropHandlers(): void } = {
    cols: init.cols,
    rows: init.rows,
    dropHandlers() {
      dataHandlers.length = 0;
      resizeHandlers.length = 0;
    },
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
  await servePackages(msg);
  if (msg.type === "pkg-read-installed") await installed.read();
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
  if (msg.type === "python-install") {
    await lifecycle.enqueue(retryPython);
    return;
  }
  if (msg.type === "jupyter-restart") {
    await lifecycle.restart(async () => {
      if (pythonMissing && installPython !== undefined) {
        await retryPython();
        return;
      }
      if (launchSession === undefined) {
        post(
          pythonMissing
            ? { type: "python-missing" }
            : { type: "error", message: "Jupyter is not ready" },
        );
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
          {
            relaunching: (launch) =>
              post({
                type: "status",
                text: `restarting Jupyter (${relaunchNote(launch)})`,
              }),
          },
        );
        subscribeJupyter(jupyter);
        post({ type: "jupyter-restarted" });
      } catch (error) {
        post({
          type: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }, () => post({ type: "error", message: "Jupyter is not ready" }));
    return;
  }
  if (msg.type === "cell-interrupt") {
    await requestCellInterrupt(jupyter, msg.id, post);
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
        result: await executeCell(
          jupyter,
          msg.code,
          {
            onStream: (chunk) =>
              post({ type: "cell-stream", id: msg.id, chunk }),
          },
        ),
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
  kernelPorts = msg.kernelPorts;
  // The live index's answers for this boot: a snapshot's check and the
  // install's stored-layer question, from one read. Made by each begin()
  // below, so a fresh sandbox asks again.
  let live: ReturnType<typeof liveAnswers>;
  const term = workerTerm({ cols: msg.cols, rows: msg.rows });
  const restoreKind: SnapshotKind = msg.snapshotKind ?? "desktop";
  const env = {
    isolated: msg.isolated,
    // The slim image when the train pins one; the desktop app's native
    // sandbox reads no image here.
    imagePath: kernelPorts === undefined
      ? await browserImagePath().catch(() => undefined)
      : undefined,
    snapshotPath:
      restoresSnapshot({ ...msg, native: kernelPorts !== undefined })
        ? isUploadedSnapshotId(msg.snapshotId)
          ? uploadedSnapshotPath(msg.snapshotId!)
          : `./${SNAPSHOT_KINDS[restoreKind].name}`
        : undefined,
    snapshotKind: restoreKind,
    snapshotCache: typeof caches === "undefined" ? undefined : caches,
    snapshotId: isUploadedSnapshotId(msg.snapshotId)
      ? msg.snapshotId
      : undefined,
    livePythonSet: () => live.pythonSet(),
    fetchBytes: (path: string) =>
      fetchPlaygroundBytes(path, (progress) => {
        const percent = progress.total === undefined
          ? `${progress.loaded} bytes`
          : `${Math.round(progress.loaded / progress.total * 100)}%`;
        post({ type: "status", text: `loading ${path}: ${percent}` });
      }),
    show: (text: string) => post({ type: "status", text }),
    term,
    memoryRefused: () => post(memoryRefusedMessage()),
    linuxRemark: (remark: string) => post({ type: "linux-remark", remark }),
    // The terminal's `pkg` fetches through the page (src/pkg_relay.ts);
    // the desktop app's guest has the network itself.
    pkgRelay: kernelPorts === undefined
      ? { tablet: msg.tablet === true }
      : undefined,
  };
  // The slim image's Python: the coordinator installs the set itself, so
  // every page that boots a sandbox gets the same install.
  const python = msg.python;
  const tablet = msg.tablet === true;
  // The desktop app's sandbox has a network and its own pkg; only the
  // in-tab one installs through the page.
  /** What a capture's install installed, as a layer key: the set its
   * own index read resolved to, so the snapshot's label is the set it
   * holds. */
  let capturedSet: string | undefined;
  const capturing = msg.snapshot === "capture";
  installPython = python === undefined || kernelPorts !== undefined
    ? undefined
    : async (session) => {
      // "installing Go" for the Go snapshot's capture.
      post({ type: "status", text: `installing ${python.label}` });
      const cache = await browserArchiveCache();
      const progress = (text: string) => post({ type: "status", text });
      layerInstalled = undefined;
      // A capture installs with pkg, never from a stored layer: the
      // snapshot is what the live index gives now.
      const store = tablet || capturing ? undefined : await browserLayerStore();
      try {
        // Instant on a later visit: this browser's earlier install, kept
        // as a layer (src/python_layer.ts), when it is still the set. All
        // in one turn of the install queue: a Packages install must not
        // land while a layer is written or read out. Not on a tablet: a
        // layer is over 100 MiB in this worker while it is made or used.
        const from = await installs(() => {
          // A Packages install queued before this one stalled here (it is
          // marked only once its recovery ends, which Try again may not
          // have waited for): install nothing into it. The next Try again
          // starts a fresh sandbox.
          if (sandboxStalled && session === packageSession) {
            throw new Error(
              `${stalledWhy} in this sandbox; Try again starts a fresh one`,
            );
          }
          // In the turn: a Packages install queued before this one has run.
          const pristine = !pkgTouched.has(session);
          pkgTouched.add(session);
          return installWithLayer({
            layer: session.layer,
            store,
            image: python.image,
            pristine,
            liveKey: () => live.layerKey(),
            install: async (between) => {
              // What pkg already has here pins the set (python, in a slim
              // image that ships it): the sandbox's own list, read now,
              // over what the pins say the image ships.
              const have = await installedReleases(session.files);
              between.before();
              await installPackage({
                ...python,
                installed: have ?? python.installed,
              }, {
                host: workerPackageHost(session),
                tablet,
                progress,
                cache,
                resolved: capturing && python.image !== undefined
                  ? (releases) => {
                    capturedSet = layerKey(python.image!, [...releases]);
                  }
                  : undefined,
              });
              between.after();
            },
            probe: () => probePython(session.process),
            progress,
          });
        });
        layerInstalled = from === "layer" ? store : undefined;
      } catch (error) {
        // A sandbox a layer was half written into, like a stalled one,
        // takes no pkg install: the retry is in a fresh one. Not if this
        // sandbox is already gone (a recovery that ended after the switch).
        if (session !== packageSession) {
          // Nothing to mark: the sandbox now in use is another one.
        } else if (error instanceof InstallStalled && error.inSandbox) {
          sandboxStalled = true;
          stalledWhy = stalledSandboxWhy(error);
        } else if (error instanceof LayerFailed) {
          sandboxStalled = true;
          stalledWhy = "a stored Python install did not work";
        }
        throw error;
      } finally {
        // Like a panel install's: what it did install, even if it failed.
        await installed.read();
      }
    };
  /** Boot, install, start Jupyter: the start, and what a retry after a
   * stalled install runs again on a fresh sandbox (the one deliberate
   * exception to "never stops the session": the stalled one is dropped
   * first). */
  const captureKind: SnapshotKind = msg.snapshotKind ?? "desktop";
  const begin = async () => {
    live = liveAnswers(msg.python ?? msg.snapshotPython);
    // Never stops the session once its shell is up (src/coordinator_start.ts).
    const started = await startSandbox({
      boot: () =>
        kernelPorts === undefined ? bootPlayground(env) : bootNativePlayground(
          env,
          msg.apiToken === undefined ? undefined : { token: msg.apiToken },
        ),
      booted: (session) => {
        if (session.process !== undefined && session.signal !== undefined) {
          executions = new ExecutionRegistry(session.process, session.signal);
        }
        packageSession = session;
        void installed.read();
      },
      // A restart relaunches on it, whether or not the first launch worked.
      launching: (session) => launchSession = session,
      noJupyter: msg.noJupyter === true,
      installPython,
      startKernel: (session, relaunching) =>
        startGuestKernel(session, kernelPorts, { relaunching }),
      captureNeeds: captureKind === "phone" ? "none" : "set",
      capture: msg.snapshot === "capture"
        ? (session) => {
          const phone = captureKind === "phone";
          // A snapshot without a Python set is a phone's, restored only by
          // a page that asks about none: only the phone's capture may make
          // one, and it installs nothing.
          if (phone && python !== undefined) {
            throw new Error("the phone's capture asks for no Python install");
          }
          // The phone's and the tablet's snapshots are the slim image's:
          // the full image (a train without one) holds the whole set.
          if (captureKind !== "desktop" && env.imagePath !== SLIM_IMAGE_PATH) {
            throw new Error(
              `the ${captureKind}'s capture needs the train's slim image (browserImage)`,
            );
          }
          if (!phone && capturedSet === undefined) {
            throw new Error(
              `this capture installed no ${
                captureKind === "go" ? "Go" : "Python"
              } (the phone's capture, without any, is ?snapshot=capture-phone)`,
            );
          }
          return captureSnapshot(
            session,
            phone ? null : capturedSet!,
            msg.capturePackages ?? [],
            captureKind,
          );
        }
        : undefined,
      post: (report) => {
        if (report.type === "python-missing") pythonMissing = true;
        dropLayerIfKernelFailed(report);
        if (report.type === "error") {
          bootError = report.message;
          // A fresh sandbox's failed boot is said once, below, where
          // Python's Try again is.
          if (freshBoot && packageSession === undefined) return;
        }
        post(report);
      },
    });
    // The boot is over: its read of the live index goes with it (a later
    // install on this sandbox asks again).
    live.finish();
    // Go's page on a sandbox without go (a fallback boot): install it.
    const goSession = packageSession;
    if (
      msg.goFallback !== undefined && kernelPorts === undefined &&
      goSession?.process !== undefined
    ) {
      const goSet = msg.goFallback;
      const spawn = goSession.process;
      await ensureGo({
        probe: async () => {
          try {
            const probe = await spawn(GO_PROBE_LINE, { maxOutputBytes: 1024 });
            const status = await probe.exited;
            return (typeof status === "number" ? status : status.code) === 0;
          } catch {
            return undefined;
          }
        },
        install: async () => {
          const cache = await browserArchiveCache();
          await installs(() => {
            pkgTouched.add(goSession);
            return installPackage(goSet, {
              host: workerPackageHost(goSession),
              tablet: false,
              progress: (text) => post({ type: "status", text }),
              cache,
            });
          });
          await installed.read();
          post({ type: "status", text: "" });
        },
        say: (text) => {
          term.write(`\r\n${text}\r\n`);
          post({ type: "status", text });
        },
      });
    }
    if (started !== undefined) {
      jupyter = started;
      subscribeJupyter(jupyter);
    }
  };
  /** The last boot error `begin` saw. */
  let bootError: string | undefined;
  /** A fresh sandbox is booting (`startFresh`). */
  let freshBoot = false;
  /** Drop the in-tab sandbox: its guests go, a hung `pkg` with them, and
   * nothing keeps its kernel (with what was staged in it) reachable -- the
   * terminal's handlers were the stopped session's last references. Apart
   * from `startFresh` so no local of that long await holds it. */
  const dropSandbox = () => {
    // What the fresh one has is unknown until it boots.
    installed.dropped();
    const stale = packageSession;
    packageSession = undefined;
    launchSession = undefined;
    executions = undefined;
    jupyter = undefined;
    try {
      stale?.dispose?.();
    } catch {
      // Already gone.
    }
    term.dropHandlers();
  };
  if (kernelPorts === undefined) {
    startFresh = async () => {
      const why = sandboxStalled ? `${stalledWhy}; ` : "";
      pythonMissing = false;
      sandboxStalled = false;
      bootError = undefined;
      env.term.write(
        `\r\n[${why}starting a fresh sandbox ` +
          "(this shell and its files go with the old one)]\r\n",
      );
      post({ type: "status", text: "starting a fresh sandbox" });
      dropSandbox();
      freshBoot = true;
      try {
        await lifecycle.start(begin);
      } finally {
        freshBoot = false;
      }
      // A fresh sandbox that did not boot: say so where Python's Try again
      // is, so the page can try once more (the retry finds no sandbox and
      // starts a fresh one).
      if (packageSession === undefined) {
        pythonMissing = true;
        post({
          type: "python-missing",
          error: `a fresh sandbox did not start: ${bootError ?? "unknown"}`,
        });
        installed.freshFailed(bootError ?? "unknown");
      }
    };
  }
  await lifecycle.start(begin);
});
