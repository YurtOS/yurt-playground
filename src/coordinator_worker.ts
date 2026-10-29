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
import { readInstalled } from "./installed_list.ts";
import {
  browserArchiveCache,
  installPackage,
  InstallStalled,
} from "./packages.ts";
import {
  browserLayerStore,
  installWithLayer,
  LayerFailed,
  layerKey,
  type LayerStore,
} from "./python_layer.ts";
import { liveAnswers } from "./python_install.ts";
import { postCaptured, precompileLine } from "./capture_outcome.ts";
import { playgroundGuestPortIsDirect } from "./guest_port_policy.ts";
import {
  encodeSandboxSnapshot,
  SANDBOX_SNAPSHOT_PATH,
  snapshotIdentity,
} from "./sandbox_snapshot.ts";
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
    // The slim image: the Python set to install when the image has no
    // python3, before ipykernel -- the newest complete one in the live
    // signed index (src/python_install.ts). Absent, such an image is
    // reported as `python-missing`, as before.
    python?: PythonRequest;
    // A tablet or phone: installs over 16 MiB are refused there.
    tablet?: boolean;
    // `?snapshot=1`: restore the sealed sandbox (src/sandbox_snapshot.ts)
    // instead of booting the image; `?snapshot=capture`: boot and install
    // as usual, then seal instead of starting Jupyter and hand the file
    // to the page (`snapshot-captured`).
    snapshot?: "restore" | "capture";
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
  | { type: "pkg-installed"; names: string[] }
  | { type: "pkg-installed"; error: string }
  | { type: "snapshot-captured"; blob: Blob; ms: number }
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
 * packages (it has `writeFiles`) and reads pkg's installed list (`readAt`). */
let packageSession: Awaited<ReturnType<typeof bootPlayground>> | undefined;

async function servePackages(msg: ToWorker): Promise<void> {
  if (msg.type !== "pkg-install") return;
  const { req } = msg;
  try {
    // The session as it is when this install's turn comes: one queued
    // behind a stalled install may find a fresh sandbox, or a stalled one.
    const output = await installs(() => {
      const session = packageSession;
      if (session?.process === undefined || session.writeFiles === undefined) {
        throw new Error("this sandbox does not install packages");
      }
      if (sandboxStalled) throw new Error(stalledSandbox());
      pkgTouched.add(session);
      return installPackage(msg.name, {
        host: workerPackageHost(session),
        tablet: msg.tablet,
        progress: (text) => post({ type: "pkg-progress", req, text }),
      });
    });
    post({ type: "pkg-reply", req, ok: true, value: output });
  } catch (error) {
    if (error instanceof InstallStalled && error.inSandbox) {
      sandboxStalled = true;
      stalledWhy = "an earlier install stopped making progress";
    }
    post({
      type: "pkg-reply",
      req,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    await postInstalled();
  }
}

/** Tell the page what pkg has installed in the in-tab sandbox, from its
 * installed list (src/installed_list.ts), or why that cannot be told: at
 * boot, after each install, and when the Packages panel opens. */
async function postInstalled(): Promise<void> {
  // The in-tab sandbox only: the desktop app's page has no Packages panel
  // to mark, and no VFS of its own to read.
  const readAt = packageSession?.readAt;
  if (readAt === undefined) return;
  try {
    const names = await readInstalled(readAt);
    post(
      names === undefined
        ? {
          type: "pkg-installed",
          error: "this image's pkg keeps no installed list",
        }
        : { type: "pkg-installed", names },
    );
  } catch (error) {
    post({
      type: "pkg-installed",
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

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
/** The image has no python3 (src/coordinator_start.ts): a restart the
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
 * (src/packages.ts `InstallStalled`): it may no longer answer, and its
 * packages are half applied. The Python install's next try is in a fresh
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

type PythonRequest = { label: string; set: string[]; image?: string };

/** `?snapshot=capture`: precompile the installed Python, seal the
 * sandbox (no process left in it) and hand the snapshot file to the page,
 * in the kernel's place: a sealed sandbox runs nothing more. */
async function captureSnapshot(
  session: Awaited<ReturnType<typeof bootPlayground>>,
  /** The Python set the capture installed, as a layer key; null when the
   * site installs none (the full image has it). */
  pythonSet: string | null,
): Promise<void> {
  if (session.seal === undefined || session.process === undefined) {
    throw new Error("this session cannot seal");
  }
  // Bytecode for every module the packages ship as source only
  // (PRECOMPILE_PROGRAM): each start compiled them again, slow on Safari,
  // where compiling one of wcwidth's modules also overflowed the Worker's
  // stack and killed ipykernel with SIGSEGV. Its failure is refused, with
  // its own words.
  post({ type: "status", text: "precompiling Python modules" });
  const compiled = performance.now();
  const compile = await session.process(precompileLine(), {
    maxOutputBytes: 64 * 1024,
  });
  const compileStatus = await compile.exited;
  const code = typeof compileStatus === "number"
    ? compileStatus
    : compileStatus.code;
  if (code !== 0) {
    const decoder = new TextDecoder();
    const said = decoder.decode(compile.takeStdout()) +
      decoder.decode(compile.takeStderr());
    throw new Error(
      `precompiling the Python set exited ${JSON.stringify(compileStatus)}: ${
        said.slice(-2000)
      }`,
    );
  }
  console.log(
    `[snapshot] precompiled in ${Math.round(performance.now() - compiled)} ms`,
  );
  post({ type: "status", text: "sealing the sandbox" });
  const started = performance.now();
  const image = await session.seal();
  const blob = await encodeSandboxSnapshot(
    image,
    { ...snapshotIdentity(await playgroundPins()), pythonSet },
  );
  postCaptured(post, blob, Math.round(performance.now() - started));
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
  if (msg.type === "pkg-read-installed") await postInstalled();
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
  const env = {
    isolated: msg.isolated,
    // The slim image when the train pins one; the desktop app's native
    // sandbox reads no image here.
    imagePath: kernelPorts === undefined
      ? await browserImagePath().catch(() => undefined)
      : undefined,
    snapshotPath:
      restoresSnapshot({ ...msg, native: kernelPorts !== undefined })
        ? SANDBOX_SNAPSHOT_PATH
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
      post({ type: "status", text: "installing Python" });
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
              between.before();
              await installPackage(python, {
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
        // takes no pkg install: the retry is in a fresh one.
        if (error instanceof InstallStalled && error.inSandbox) {
          sandboxStalled = true;
          stalledWhy = "an earlier install stopped making progress";
        } else if (error instanceof LayerFailed) {
          sandboxStalled = true;
          stalledWhy = "a stored Python install did not work";
        }
        throw error;
      } finally {
        // Like a panel install's: what it did install, even if it failed.
        await postInstalled();
      }
    };
  /** Boot, install, start Jupyter: the start, and what a retry after a
   * stalled install runs again on a fresh sandbox (the one deliberate
   * exception to "never stops the session": the stalled one is dropped
   * first). */
  const begin = async () => {
    live = liveAnswers(msg.python);
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
        void postInstalled();
      },
      // A restart relaunches on it, whether or not the first launch worked.
      launching: (session) => launchSession = session,
      noJupyter: msg.noJupyter === true,
      installPython,
      startKernel: (session, relaunching) =>
        startGuestKernel(session, kernelPorts, { relaunching }),
      capture: msg.snapshot === "capture"
        ? (session) => {
          if (python?.image !== undefined && capturedSet === undefined) {
            throw new Error("the capture's Python install did not run");
          }
          return captureSnapshot(session, capturedSet ?? null);
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
    // Nothing is known of the fresh one until it boots.
    post({ type: "pkg-installed", names: [] });
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
      }
    };
  }
  await lifecycle.start(begin);
});
