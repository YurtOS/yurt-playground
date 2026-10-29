/**
 * The coordinator's `start`: boot the sandbox, then the Jupyter kernel on
 * it. Apart from the worker (src/coordinator_worker.ts) so the order and
 * the failure rules can be tested without one.
 *
 * Two rules hold here:
 *
 * - An image without the Python set (the slim base image: no python3, or
 *   only the python package) gets the shell, then
 *   the Python set installed from the live index when the page asked for it
 *   (`installPython`), then ipykernel. Without that, or when the install
 *   fails, it gets `python-missing` (with the install's error); no
 *   ipykernel launch is tried, since it can only fail after the
 *   connection-file wait.
 * - Once the shell is up, nothing here stops the session. A Jupyter that
 *   does not start is an `error` the page shows next to a working shell;
 *   stopping the session on it killed the terminal without a word.
 */
import type { JupyterTransport } from "./jupyter_transport.ts";
import { relaunchNote } from "./jupyter.ts";
import { asWaitStatus, type Spawner } from "./executions.ts";

/** What `start` posts to the page about the boot. */
export type StartReport =
  | { type: "status"; text: string }
  // `endsBoot`: the start's own outcome (a boot that failed, a Jupyter
  // that did not start), apart from a later error such as a cell's.
  | { type: "error"; message: string; endsBoot?: true }
  | { type: "shell-ready" }
  // The image has no python3: the shell runs, Jupyter is not launched.
  // `error` is why installing it failed, when that was tried.
  | { type: "python-missing"; error?: string }
  | { type: "notebook-ready" };

/** The probe's own answer for "no python3": a code nothing else in the
 * probe exits with. Any other nonzero exit -- a redirect that failed (a
 * full /tmp), a shell that could not start, a SIGKILL folded to 137, even
 * `command -v`'s own 127 -- is not an answer, and the launch goes ahead. */
export const PYTHON_MISSING_EXIT = 42;

/** The probe's answer for "python3, but not the Python set": the slim
 * image's own python package, or an install that stopped part way. The
 * kernel cannot start on it, so the page installs the set, as for 42; the
 * agent's prompt (src/agent_tools.ts) still has a python3. */
export const PYTHON_SET_MISSING_EXIT = 43;

/** Where the Python set's packages are: the python package's
 * site-packages, whichever 3.x it is. */
export const PYTHON_SITE_PACKAGES = "/usr/local/lib/python3.*/site-packages";

/** What the Jupyter kernel imports beside python3, one file per package of
 * the set (src/python_install.ts `PYTHON_SET`): numpy's and pyzmq's, and
 * jupyter-kernel's launcher, which `python3 -m ipykernel_launcher` runs.
 * Files, not imports: `python3 -c 'import ipykernel'` is the kernel's own
 * JIT-bound start, tens of seconds at boot. */
export const PYTHON_SET_FILES = [
  "numpy/__init__.py",
  "zmq/__init__.py",
  "ipykernel_launcher.py",
];

/** The command that answers "can the Jupyter kernel start here?": 0 when
 * python3 is on PATH and the set's files are in its site-packages, 42 when
 * there is no python3, 43 when there is one without the set. Shell
 * builtins only, no python3 run: it is the boot's, and must be cheap. */
export const PYTHON_PROBE_COMMAND = [
  `command -v python3 >/dev/null || exit ${PYTHON_MISSING_EXIT}`,
  `for s in ${PYTHON_SITE_PACKAGES}; do ${
    PYTHON_SET_FILES.map((file) => `[ -f "$s/${file}" ] &&`).join(" ")
  } exit 0; done`,
  `exit ${PYTHON_SET_MISSING_EXIT}`,
].join("; ");

/** The probe as a Spawner line, `exec`'d like every line a Spawner runs,
 * so its redirects bind here. */
export const PYTHON_PROBE_LINE = `exec /bin/sh -c '${PYTHON_PROBE_COMMAND}'`;

/** The probe the phone's capture asks instead (`?snapshot=capture-phone`,
 * `captureInterpreterOnly`): only "is there a python3?", 0 or 42. The
 * phone's snapshot is the image's own python3, without the set. */
export const PYTHON_INTERPRETER_PROBE_LINE =
  `exec /bin/sh -c 'command -v python3 >/dev/null && exit 0; exit ${PYTHON_MISSING_EXIT}'`;

/** The probe is a few BusyBox builtins; a probe that takes longer than
 * this is a sandbox in trouble, and the launch goes ahead as before. */
export const PYTHON_PROBE_TIMEOUT_MS = 30_000;

/** `false` when the image has no python3 or not the Python set beside it
 * (the kernel cannot start), `true` when it has both, and
 * `undefined` when the session cannot tell (no process of its own, as on
 * the desktop app's page, or a probe that failed or hung): the launch is
 * then tried as before, and fails on its own if it must. */
export async function probePython(
  spawn: Spawner | undefined,
  timeoutMs = PYTHON_PROBE_TIMEOUT_MS,
  line = PYTHON_PROBE_LINE,
): Promise<boolean | undefined> {
  if (spawn === undefined) return undefined;
  let timer: number | undefined;
  try {
    const process = await spawn(line, { maxOutputBytes: 4096 });
    const status = await Promise.race([
      process.exited,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), timeoutMs);
      }),
    ]);
    if (status === undefined) return undefined;
    const code = asWaitStatus(status).code;
    if (code === 0) return true;
    if (code === PYTHON_MISSING_EXIT || code === PYTHON_SET_MISSING_EXIT) {
      return false;
    }
    // A signal death, or any exit the probe itself did not choose, says
    // nothing about Python.
    return undefined;
  } catch {
    return undefined;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export type StartableSession = { process?: Spawner };

export type StartDeps<S extends StartableSession> = {
  /** Boot the sandbox; resolves once the shell is up. */
  boot(): Promise<S>;
  /** The booted session, before anything else is tried on it: the
   * worker's registries take it here. */
  booted(session: S): void;
  /** A tablet: the shell is the whole session. */
  noJupyter: boolean;
  /** Install Python on an image that has none, before the kernel starts
   * (progress goes out as `status`). Absent: such an image is reported as
   * `python-missing`. */
  installPython?(session: S): Promise<void>;
  /** Just before the kernel is launched on it: what a restart reuses. */
  launching?(session: S): void;
  /** Calls `relaunching` before each launch after a stack overflow. */
  startKernel(
    session: S,
    relaunching: (launch: number) => void,
  ): Promise<JupyterTransport>;
  /** `?snapshot=capture`: what runs on the sandbox in the kernel's place,
   * once Python is there. It says its own success; its failure is posted
   * as a failed capture, not as a Jupyter that did not start. */
  capture?(session: S): Promise<void>;
  /** The phone's capture (`?snapshot=capture-phone`): it installs
   * nothing and needs only python3, not the Python set. */
  captureInterpreterOnly?: boolean;
  post(report: StartReport): void;
  /** How often "starting Jupyter (N s)" is posted. */
  tickMs?: number;
  probeTimeoutMs?: number;
};

/** Boot, then Jupyter; the kernel's transport once it answered, else
 * `undefined`. Never throws: every failure is a posted `error`. */
export async function startSandbox<S extends StartableSession>(
  deps: StartDeps<S>,
): Promise<JupyterTransport | undefined> {
  const errorText = (error: unknown) =>
    error instanceof Error ? error.message : String(error);
  let session: S;
  try {
    session = await deps.boot();
  } catch (error) {
    deps.post({ type: "error", message: errorText(error), endsBoot: true });
    return undefined;
  }
  deps.booted(session);
  if (deps.noJupyter) {
    deps.post({ type: "status", text: "" });
    deps.post({ type: "shell-ready" });
    return undefined;
  }
  // The phone's capture seals the image's own python3: it needs python3,
  // not the set.
  const interpreterOnly = deps.capture !== undefined &&
    deps.captureInterpreterOnly === true;
  const probed = await probePython(
    session.process,
    deps.probeTimeoutMs,
    interpreterOnly ? PYTHON_INTERPRETER_PROBE_LINE : PYTHON_PROBE_LINE,
  );
  if (probed === false) return await installThenLaunch(session, deps);
  return await launchKernel(session, deps);
}

/** Install Python, then start the kernel: the slim image's path at boot,
 * and what a retry (the Install button, a frontend restart) runs after a
 * failed install. Never throws: a failure is `python-missing` with its
 * error, and the shell stays. */
export async function installThenLaunch<S extends StartableSession>(
  session: S,
  deps: Pick<
    StartDeps<S>,
    | "installPython"
    | "launching"
    | "startKernel"
    | "capture"
    | "post"
    | "tickMs"
  >,
): Promise<JupyterTransport | undefined> {
  // A capture without its Python is a failed capture, said as one: it
  // ends the boot, where python-missing would leave a shell to use.
  const missing = (error?: string) =>
    deps.post(
      deps.capture === undefined
        ? { type: "python-missing", ...(error === undefined ? {} : { error }) }
        : {
          type: "error",
          message: `snapshot capture failed: ${
            error ?? "this site installs no Python"
          }`,
          endsBoot: true,
        },
    );
  if (deps.installPython === undefined) {
    missing();
    return undefined;
  }
  try {
    await deps.installPython(session);
  } catch (error) {
    missing(error instanceof Error ? error.message : String(error));
    return undefined;
  }
  return await launchKernel(session, deps);
}

async function launchKernel<S extends StartableSession>(
  session: S,
  deps: Pick<
    StartDeps<S>,
    "launching" | "startKernel" | "capture" | "post" | "tickMs"
  >,
): Promise<JupyterTransport | undefined> {
  const errorText = (error: unknown) =>
    error instanceof Error ? error.message : String(error);
  if (deps.capture !== undefined) {
    try {
      await deps.capture(session);
    } catch (error) {
      deps.post({
        type: "error",
        message: `snapshot capture failed: ${errorText(error)}`,
        endsBoot: true,
      });
    }
    return undefined;
  }
  deps.post({ type: "status", text: "starting Jupyter" });
  // ipykernel's imports are JIT-bound: ~30 s on a laptop, minutes on a
  // small or busy machine (yurt-playground#89). A count that moves is
  // the difference between slow and stuck.
  deps.launching?.(session);
  const started = Date.now();
  /** Which launch this is, once one overflowed the stack: every tick says
   * so, or the next one would wipe it within seconds. */
  let note = "";
  const tick = () => {
    const seconds = Math.round((Date.now() - started) / 1000);
    deps.post({
      type: "status",
      text: `starting Jupyter (${seconds} s${note})`,
    });
  };
  const ticking = setInterval(tick, deps.tickMs ?? 5000);
  let jupyter: JupyterTransport;
  try {
    jupyter = await deps.startKernel(session, (launch) => {
      note = `, ${relaunchNote(launch)}`;
      tick();
    });
  } catch (error) {
    // The shell stays: the session is not stopped for a kernel that did
    // not start.
    deps.post({
      type: "error",
      message: `Jupyter did not start: ${errorText(error)}`,
      endsBoot: true,
    });
    return undefined;
  } finally {
    clearInterval(ticking);
  }
  deps.post({ type: "notebook-ready" });
  return jupyter;
}

/** Whether a start's error says the Python it ran is broken, so a stored
 * layer that installed it must go. A stack overflow on every launch counts
 * too: a broken native extension in the layer dies the same way, and a
 * fresh install on the next visit is the safe direction. */
export function kernelFailureDropsLayer(report: StartReport): boolean {
  return report.type === "error" &&
    report.message.startsWith("Jupyter did not start");
}

/** The worker's kernel lifecycle: the boot's start, and the restarts and
 * Python installs that run one at a time. A restart that comes in while a
 * start runs is refused at once, as before the relaunch: queued, it waited
 * out minutes of ipykernel import and then restarted the fresh kernel. */
export function kernelLifecycle() {
  // A count, not a flag: the boot's start and a fresh sandbox's start
  // (retryPython → startFresh) may overlap, and the first to end must not
  // let a restart in beside the other.
  let starting = 0;
  let queue: Promise<void> = Promise.resolve();
  /** Runs `run` after everything queued before it; a rejection is the
   * caller's, and does not stop what is queued next. */
  const enqueue = (run: () => Promise<void>): Promise<void> => {
    const next = queue.then(run);
    queue = next.catch(() => {});
    return next;
  };
  return {
    async start(run: () => Promise<void>): Promise<void> {
      starting++;
      try {
        await run();
      } finally {
        starting--;
      }
    },
    enqueue,
    restart(run: () => Promise<void>, refuse: () => void): Promise<void> {
      if (starting > 0) {
        refuse();
        return Promise.resolve();
      }
      return enqueue(run);
    },
  };
}

/** Whether a start restores a sealed sandbox (`?snapshot=1` or an
 * uploaded one): only the in-tab sandbox (the desktop app's runs
 * natively). A phone or tablet too: its page asks for no Python set, so
 * the restore takes only a snapshot without one (checkPythonSet, before
 * anything is downloaded) -- the phone's, `?snapshot=capture-phone`. The
 * full one, 130 MB downloaded and ~520 MiB inflated, is more than such a
 * tab keeps, and is refused there. */
export function restoresSnapshot(start: {
  snapshot?: "restore" | "capture";
  tablet?: boolean;
  native: boolean;
}): boolean {
  return start.snapshot === "restore" && !start.native;
}
