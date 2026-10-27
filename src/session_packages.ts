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
  type StagedFile,
  STAGING_DIR,
} from "./packages.ts";

export type BootedSession = Awaited<ReturnType<typeof bootPlayground>>;

/** The guest's `pkg` output is a few lines; a megabyte is plenty. */
const PKG_OUTPUT_BYTES = 1024 * 1024;

/** Write the staged repository copy (as root) and run `script` on it as the
 * login user: one `pkg` run of an install (src/packages.ts). Throws when
 * staging or the spawn fails, not when pkg does. */
export async function runStaged(
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
    stageAndRun: (files, script) => runStaged(session, files, script),
  };
}
