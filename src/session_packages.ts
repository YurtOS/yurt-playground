/**
 * A package install on a booted in-tab session (src/boot.ts): the
 * {@link PackageHost} that writes the staged repository copy into the
 * guest and runs the guest's own `sudo pkg` on it. The coordinator installs
 * through it, and so does the Suspend/Resume kernel, in a short-lived
 * sandbox of its own, to have the guest's `pkg` verify what it will run.
 */
import type { bootPlayground } from "./boot.ts";
import { quoted } from "./executions.ts";
import {
  onlyStaged,
  type PackageHost,
  type RunWatch,
  type StagedFile,
  STAGING_DIR,
} from "./packages.ts";

export type BootedSession = Awaited<ReturnType<typeof bootPlayground>>;

/** The guest's `pkg` output is a few lines; a megabyte is plenty. */
const PKG_OUTPUT_BYTES = 1024 * 1024;

/** The heartbeat's byte, on the script's stderr: pkg never prints it, and
 * it is removed from what the run returns. */
export const HEARTBEAT = "\x1e";
const HEARTBEAT_BYTE = HEARTBEAT.charCodeAt(0);

/** How often the guest beats, and the page looks. */
export const HEARTBEAT_SECONDS = 2;

/** `script` with a guest heartbeat beside it. `pkg` prints nothing until
 * it is done (about a minute for Python), so its own output cannot tell
 * slow from hung. The beat can tell some hangs: a background loop writes
 * {@link HEARTBEAT} to stderr every couple of seconds while the script's
 * shell has a child -- the `pkg` it waits for (`sudo` execs it). The loop
 * runs as root (`privileged`), since the login user's /proc does not list
 * root's processes, `pkg` among them. It stops beating when `pkg` is gone
 * but the shell was never told (a lost child exit), and when the sandbox
 * stops running anything. A `pkg`
 * that is alive but blocked keeps it beating; the install's run ceiling
 * (src/packages.ts `INSTALL_RUN_CEILING_MS`) is the backstop for that. A
 * shell between two commands has no child for a moment; one missed beat
 * is nothing next to the no-progress window. A zombie child does not
 * count. It ends within one beat of the shell. */
export function withHeartbeat(
  script: string,
  seconds = HEARTBEAT_SECONDS,
  privileged = "sudo ",
): string {
  // A child that is not a zombie: one that exited unreaped (a lost child
  // exit) is no `pkg` at work. From /proc with builtins (the field after
  // the last ")" is the state, then the parent); where there is no /proc
  // (a test host), pgrep; with neither, the shell being alive.
  const loop = [
    'while kill -0 "$0" 2>/dev/null; do',
    "  child=",
    "  if [ -r /proc/self/stat ]; then",
    "    for f in /proc/[0-9]*/stat; do",
    // Braced: a process gone since the glob fails the redirect itself,
    // which a 2>/dev/null after it would not silence.
    '      { read -r l < "$f"; } 2>/dev/null || continue',
    '      set -- ${l##*")"}',
    '      [ "$2" = "$0" ] && [ "$1" != Z ] && { child=1; break; }',
    "    done",
    "  elif command -v pgrep >/dev/null; then",
    '    pgrep -P "$0" >/dev/null && child=1',
    "  else",
    "    child=1",
    "  fi",
    `  [ -n "$child" ] && printf '${HEARTBEAT}' >&2`,
    `  sleep ${seconds}`,
    "done",
  ].join("\n");
  return [
    `/bin/sh -c ${quoted(script)} &`,
    "inner=$!",
    `${privileged}/bin/sh -c ${quoted(loop)} "$inner" &`,
    'wait "$inner"',
  ].join("\n");
}

/** `bytes` without the heartbeat's byte. */
function withoutBeats(bytes: Uint8Array): Uint8Array {
  return bytes.includes(HEARTBEAT_BYTE)
    ? bytes.filter((byte) => byte !== HEARTBEAT_BYTE)
    : bytes;
}

/** Write the staged repository copy (as root) and run `script` on it as the
 * login user: one `pkg` run of an install (src/packages.ts). Throws when
 * staging or the spawn fails, not when pkg does. */
export async function runStaged(
  session: Pick<BootedSession, "process" | "writeFiles">,
  files: StagedFile[],
  script: string,
  watch?: RunWatch,
  pollMs = HEARTBEAT_SECONDS * 1000,
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
  // An install that has given up stages and runs nothing more.
  if (watch?.signal.aborted === true) {
    throw new Error("the install stopped watching this run");
  }
  let abandoned = false;
  try {
    session.writeFiles(files);
    // In the guest now: let the tab's copies go while `pkg` runs (up to
    // hundreds of MB).
    files.length = 0;
    const process = await run(
      watch === undefined ? script : withHeartbeat(script),
    );
    let status: Awaited<typeof process.exited>;
    if (watch === undefined) {
      status = await process.exited;
    } else {
      // The output so far, read from the guest's files by the host (not by
      // a guest process, which a hung sandbox would never run): any growth
      // -- a beat, or pkg's own words -- is the guest still working.
      let seen = 0;
      const poll = setInterval(async () => {
        try {
          const now = await process.peek?.();
          if (now === undefined) return;
          const size = now.stdout.byteLength + now.stderr.byteLength;
          if (size > seen) {
            seen = size;
            watch.alive();
          }
        } catch {
          // A read that failed is no progress, and no reason to stop.
        }
      }, pollMs);
      try {
        status = await new Promise((resolve, reject) => {
          process.exited.then(resolve, reject);
          // The install gave up on this run: stop watching it. The run
          // itself is the sandbox's; a retry starts a fresh one.
          const giveUp = () => {
            abandoned = true;
            reject(new Error("the install stopped watching this run"));
          };
          if (watch.signal.aborted) giveUp();
          watch.signal.addEventListener("abort", giveUp, { once: true });
        });
      } finally {
        clearInterval(poll);
      }
    }
    const decoder = new TextDecoder();
    return {
      code: typeof status === "number" ? status : status.code,
      stdout: decoder.decode(process.takeStdout()),
      stderr: decoder.decode(withoutBeats(process.takeStderr())),
    };
  } finally {
    // The script's trap removes the staged copy, unless the shell died by
    // a signal (the tab out of memory, say) or never ran; it may be
    // hundreds of MB of the tab's memory, so it goes here too, whatever
    // happened. Before returning: the next run stages at the same path.
    // Best effort. Not for a run given up on: its sandbox may not run
    // anything, and the copy goes with it (the next try is in a fresh one).
    if (!abandoned) {
      await run(`sudo rm -rf ${quoted(STAGING_DIR)}`).then((p) => p.exited)
        .catch(() => {});
    }
  }
}

/** The worker's own {@link PackageHost}: the coordinator installs the
 * Python set and the Packages panel's packages itself, on every page; the
 * Suspend/Resume kernel verifies its set with it. */
export function workerPackageHost(session: BootedSession): PackageHost {
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
    stageAndRun: (files, script, watch) =>
      runStaged(session, files, script, watch),
    // The in-tab session's processes can be read while they run.
    observesProgress: session.process !== undefined,
  };
}
