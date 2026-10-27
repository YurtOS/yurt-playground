/**
 * The coordinator's `start`: boot the sandbox, then the Jupyter kernel on
 * it. Apart from the worker (src/coordinator_worker.ts) so the order and
 * the failure rules can be tested without one.
 *
 * Two rules hold here:
 *
 * - An image without python3 (the slim base image) gets the shell, then
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
import type { Spawner } from "./executions.ts";

/** What `start` posts to the page about the boot. */
export type StartReport =
  | { type: "status"; text: string }
  | { type: "error"; message: string }
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

/** The command that answers "is there a python3?": 0 yes, 42 no. */
export const PYTHON_PROBE_COMMAND =
  `command -v python3 >/dev/null && exit 0; exit ${PYTHON_MISSING_EXIT}`;

/** The probe as a Spawner line, `exec`'d like every line a Spawner runs,
 * so its redirects bind here. */
export const PYTHON_PROBE_LINE = `exec /bin/sh -c '${PYTHON_PROBE_COMMAND}'`;

/** The probe is one BusyBox builtin; a probe that takes longer than this
 * is a sandbox in trouble, and the launch goes ahead as before. */
export const PYTHON_PROBE_TIMEOUT_MS = 30_000;

/** `false` when the image has no python3, `true` when it has one, and
 * `undefined` when the session cannot tell (no process of its own, as on
 * the desktop app's page, or a probe that failed or hung): the launch is
 * then tried as before, and fails on its own if it must. */
export async function probePython(
  spawn: Spawner | undefined,
  timeoutMs = PYTHON_PROBE_TIMEOUT_MS,
): Promise<boolean | undefined> {
  if (spawn === undefined) return undefined;
  let timer: number | undefined;
  try {
    const process = await spawn(PYTHON_PROBE_LINE, { maxOutputBytes: 4096 });
    const status = await Promise.race([
      process.exited,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), timeoutMs);
      }),
    ]);
    if (status === undefined) return undefined;
    const code = typeof status === "number" ? status : status.code;
    if (code === 0) return true;
    if (code === PYTHON_MISSING_EXIT) return false;
    // A signal death, or any exit the probe itself did not choose, says
    // nothing about python3.
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
  startKernel(session: S): Promise<JupyterTransport>;
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
    deps.post({ type: "error", message: errorText(error) });
    return undefined;
  }
  deps.booted(session);
  if (deps.noJupyter) {
    deps.post({ type: "status", text: "" });
    deps.post({ type: "shell-ready" });
    return undefined;
  }
  if (await probePython(session.process, deps.probeTimeoutMs) === false) {
    if (deps.installPython === undefined) {
      deps.post({ type: "python-missing" });
      return undefined;
    }
    return await installThenLaunch(session, deps);
  }
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
    "installPython" | "launching" | "startKernel" | "post" | "tickMs"
  >,
): Promise<JupyterTransport | undefined> {
  if (deps.installPython === undefined) {
    deps.post({ type: "python-missing" });
    return undefined;
  }
  try {
    await deps.installPython(session);
  } catch (error) {
    deps.post({
      type: "python-missing",
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
  return await launchKernel(session, deps);
}

async function launchKernel<S extends StartableSession>(
  session: S,
  deps: Pick<StartDeps<S>, "launching" | "startKernel" | "post" | "tickMs">,
): Promise<JupyterTransport | undefined> {
  const errorText = (error: unknown) =>
    error instanceof Error ? error.message : String(error);
  deps.post({ type: "status", text: "starting Jupyter" });
  // ipykernel's imports are JIT-bound: ~30 s on a laptop, minutes on a
  // small or busy machine (yurt-playground#89). A count that moves is
  // the difference between slow and stuck.
  deps.launching?.(session);
  const started = Date.now();
  const ticking = setInterval(() => {
    const seconds = Math.round((Date.now() - started) / 1000);
    deps.post({ type: "status", text: `starting Jupyter (${seconds} s)` });
  }, deps.tickMs ?? 5000);
  let jupyter: JupyterTransport;
  try {
    jupyter = await deps.startKernel(session);
  } catch (error) {
    // The shell stays: the session is not stopped for a kernel that did
    // not start.
    deps.post({
      type: "error",
      message: `Jupyter did not start: ${errorText(error)}`,
    });
    return undefined;
  } finally {
    clearInterval(ticking);
  }
  deps.post({ type: "notebook-ready" });
  return jupyter;
}
