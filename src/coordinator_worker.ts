/// <reference lib="deno.worker" />
/**
 * Browser coordinator. WorkerHost.spawnRootLeader uses Atomics.wait, which
 * is legal here and illegal on the window thread.
 */
import {
  bootPlayground,
  browserImagePath,
  fetchPlaygroundBytes,
  type PlaygroundTerm,
} from "./boot.ts";
import {
  executeCell,
  type JupyterStream,
  type KernelPorts,
  restartGuestKernel,
  startGuestKernel,
} from "./jupyter.ts";
import { requestCellInterrupt } from "./cell_interrupt.ts";
import {
  installThenLaunch,
  type StartReport,
  startSandbox,
} from "./coordinator_start.ts";
import { bootNativePlayground } from "./native.ts";
import {
  type ExecOptions,
  type ExecutionRecord,
  ExecutionRegistry,
  quoted,
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
  browserArchiveCache,
  installPackage,
  onlyStaged,
  type PackageHost,
  type StagedFile,
  STAGING_DIR,
} from "./packages.ts";
import { playgroundGuestPortIsDirect } from "./guest_port_policy.ts";
import { runQueue } from "./run_queue.ts";
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
    python?: { label: string; set: string[] };
    // A tablet or phone: installs over 16 MiB are refused there.
    tablet?: boolean;
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
  // A package install (src/packages.ts): the staged repository copy, then
  // the script that runs `sudo pkg` on it, as the login user.
  | {
    type: "pkg-run";
    req: number;
    files: { path: string; bytes: Uint8Array }[];
    script: string;
  };

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
  | {
    type: "pkg-reply";
    req: number;
    ok: boolean;
    value?: { code: number | null; stdout: string; stderr: string };
    error?: string;
  };

let jupyter: JupyterTransport | undefined;
let launchSession: Awaited<ReturnType<typeof bootPlayground>> | undefined;
let executions: ExecutionRegistry | undefined;
/** The in-tab session, for package installs; the desktop app's has none
 * (its sandbox has a network, and `pkg install` there needs no page). */
let packageSession: Awaited<ReturnType<typeof bootPlayground>> | undefined;

/** The guest's `pkg` output is a few lines; a megabyte is plenty. */
const PKG_OUTPUT_BYTES = 1024 * 1024;

async function servePackages(msg: ToWorker): Promise<void> {
  if (msg.type !== "pkg-run") return;
  const reply = (
    ok: boolean,
    value?: { code: number | null; stdout: string; stderr: string },
    error?: string,
  ) => post({ type: "pkg-reply", req: msg.req, ok, value, error });
  const session = packageSession;
  if (session?.process === undefined || session.writeFiles === undefined) {
    reply(false, undefined, "this sandbox does not install packages");
    return;
  }
  const files = msg.files;
  // In the guest once written: the tab's copies go while `pkg` runs.
  msg.files = [];
  try {
    reply(true, await runStaged(session, files, msg.script));
  } catch (error) {
    // Staging or the spawn failed, not pkg: said as that.
    reply(
      false,
      undefined,
      error instanceof Error ? error.message : String(error),
    );
  }
}

type BootedSession = Awaited<ReturnType<typeof bootPlayground>>;

/** The one `pkg` run at a time: every run stages at the same directory
 * and removes it at the end, and pkg takes one lock, so the Packages
 * panel's runs and the automatic Python install's wait their turn. */
const pkgRuns = runQueue();

/** Write the staged repository copy (as root) and run `script` on it as the
 * login user: one `pkg` run of an install (src/packages.ts), after any run
 * already queued. Throws when staging or the spawn fails, not when pkg
 * does. */
function runStaged(
  session: BootedSession,
  files: StagedFile[],
  script: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return pkgRuns(() => runStagedNow(session, files, script));
}

async function runStagedNow(
  session: BootedSession,
  files: StagedFile[],
  script: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  if (session.process === undefined || session.writeFiles === undefined) {
    throw new Error("this sandbox does not install packages");
  }
  // Only the staging copy: the files are written as root.
  if (!onlyStaged(files)) {
    throw new Error("package files outside the staging directory");
  }
  const spawn = session.process;
  // As the login user, like everything else the page runs: the script
  // gets root for `pkg` the way the user does, through `sudo`.
  const run = (line: string) =>
    spawn(`exec /bin/sh -c ${quoted(line)}`, {
      maxOutputBytes: PKG_OUTPUT_BYTES,
    });
  try {
    session.writeFiles(files);
    // In the guest now: let the tab's copies go while `pkg` runs (up to
    // hundreds of MB).
    files.length = 0;
    const process = await run(script);
    const status = await process.exited;
    const decoder = new TextDecoder();
    return {
      code: typeof status === "number" ? status : status.code,
      stdout: decoder.decode(process.takeStdout()),
      stderr: decoder.decode(process.takeStderr()),
    };
  } finally {
    // The script's trap removes the staged copy, unless the shell died by
    // a signal (the tab out of memory, say) or never ran; it may be
    // hundreds of MB of the tab's memory, so it goes here too, whatever
    // happened. Before returning: the next run stages at the same path.
    // Best effort.
    await run(`sudo rm -rf ${quoted(STAGING_DIR)}`).then((p) => p.exited)
      .catch(() => {});
  }
}

/** The worker's own {@link PackageHost}: the coordinator installs the
 * pinned Python packages itself, on the Notebook and Lab pages too. */
function workerPackageHost(session: BootedSession): PackageHost {
  return {
    async readFile(path) {
      if (session.process === undefined) {
        throw new Error("this sandbox does not install packages");
      }
      const process = await session.process(`exec cat ${quoted(path)}`, {
        maxOutputBytes: PKG_OUTPUT_BYTES,
      });
      const status = await process.exited;
      const code = typeof status === "number" ? status : status.code;
      if (code !== 0) throw new Error(`cannot read ${path}`);
      return process.takeStdout();
    },
    stageAndRun: (files, script) => runStaged(session, files, script),
  };
}

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
/** Restarts are serialised: a second request waits for the first. */
let restarting: Promise<void> = Promise.resolve();
/** How the start installs Python on the slim image, kept for a retry. */
let installPython:
  | ((session: BootedSession) => Promise<void>)
  | undefined;

/** Install Python again, then start the kernel (`python-install`, or a
 * frontend restart while Python is missing). */
async function retryPython(): Promise<void> {
  const session = packageSession;
  if (session === undefined || installPython === undefined) {
    post({ type: "python-missing" });
    return;
  }
  const started = await installThenLaunch(session, {
    installPython,
    launching: (s) => launchSession = s,
    startKernel: (s) => startGuestKernel(s, kernelPorts),
    post: (report) => {
      pythonMissing = report.type === "python-missing";
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
  await serveYurt(msg);
  await servePackages(msg);
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
    restarting = restarting.then(retryPython);
    await restarting;
    return;
  }
  if (msg.type === "jupyter-restart") {
    restarting = restarting.then(async () => {
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
        );
        subscribeJupyter(jupyter);
        post({ type: "jupyter-restarted" });
      } catch (error) {
        post({
          type: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    });
    await restarting;
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
  const env = {
    isolated: msg.isolated,
    // The slim image when the train pins one; the desktop app's native
    // sandbox reads no image here.
    imagePath: kernelPorts === undefined
      ? await browserImagePath().catch(() => undefined)
      : undefined,
    fetchBytes: (path: string) =>
      fetchPlaygroundBytes(path, (progress) => {
        const percent = progress.total === undefined
          ? `${progress.loaded} bytes`
          : `${Math.round(progress.loaded / progress.total * 100)}%`;
        post({ type: "status", text: `loading ${path}: ${percent}` });
      }),
    show: (text: string) => post({ type: "status", text }),
    term: workerTerm({ cols: msg.cols, rows: msg.rows }),
    memoryRefused: () => post(memoryRefusedMessage()),
  };
  // The slim image's Python: the coordinator installs the set itself, so
  // every page that boots a sandbox gets the same install.
  const python = msg.python;
  const tablet = msg.tablet === true;
  // The desktop app's sandbox has a network and its own pkg; only the
  // in-tab one installs through the page.
  installPython = python === undefined || kernelPorts !== undefined
    ? undefined
    : async (session) => {
      post({ type: "status", text: "installing Python" });
      await installPackage(python, {
        host: workerPackageHost(session),
        tablet,
        progress: (text) => post({ type: "status", text }),
        cache: await browserArchiveCache(),
      });
    };
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
    },
    // A restart relaunches on it, whether or not the first launch worked.
    launching: (session) => launchSession = session,
    noJupyter: msg.noJupyter === true,
    installPython,
    startKernel: (session) => startGuestKernel(session, kernelPorts),
    post: (report) => {
      if (report.type === "python-missing") pythonMissing = true;
      post(report);
    },
  });
  if (started !== undefined) {
    jupyter = started;
    subscribeJupyter(jupyter);
  }
});
