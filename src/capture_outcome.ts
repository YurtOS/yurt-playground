/**
 * `?snapshot=capture`'s parts that can be tested apart from the DOM and
 * the worker: what the worker runs to precompile the Python set, how it
 * announces the captured file; how the page marks the capture's outcome
 * where scripts/release-snapshot.ts waits for it, and hands the file to
 * the browser as a download.
 */

/** Where the outcome is marked: `<html>`'s dataset in the page
 * (`data-snapshot-capture`, `data-snapshot-capture-error`). */
export type CaptureMark = {
  snapshotCapture?: string;
  snapshotCaptureError?: string;
};

/** The reason a failed capture gets when no caller names one. */
export const NO_SNAPSHOT = "the boot ended without a snapshot";

/** The boot ended. In a capture, any end but the captured file -- an
 * error, a shell-only session, a worker that died -- is a failed capture;
 * `why` names it when the caller knows. A named reason stays: a later one
 * replaces only the generic {@link NO_SNAPSHOT}. */
export function markBootEnded(
  mark: CaptureMark,
  capturing: boolean,
  why?: string,
): void {
  if (!capturing || mark.snapshotCapture === "captured") return;
  mark.snapshotCapture = "failed";
  // An empty reason names nothing.
  const named = (mark.snapshotCaptureError ?? "") !== "" &&
    mark.snapshotCaptureError !== NO_SNAPSHOT;
  if (!named) mark.snapshotCaptureError = why || NO_SNAPSHOT;
}

/** The captured file arrived: save it, mark the capture, end the boot --
 * or, when saving throws, end the boot with that as the failure and say
 * so (`fail`, the page's status line), so the release script and the
 * reader hear of it at once. */
export function finishCapture(
  mark: CaptureMark,
  save: () => void,
  endBoot: (why?: string) => void,
  fail: (message: string) => void,
): void {
  try {
    save();
  } catch (error) {
    const message = `saving the snapshot failed: ${
      error instanceof Error ? error.message : String(error)
    }`;
    endBoot(message);
    fail(message);
    return;
  }
  // Captured: whatever ends the boot after this is no failure.
  mark.snapshotCapture = "captured";
  endBoot();
}

/** How long the page keeps the file's object URL after the download
 * started: revoked at once, Firefox and Safari can cut the download short. */
export const DOWNLOAD_URL_KEEP_MS = 30_000;

/** What saving a download needs from the page. */
export type DownloadHost = {
  createObjectURL(blob: Blob): string;
  revokeObjectURL(url: string): void;
  /** A link appended to the document, clicked, and removed. */
  click(href: string, name: string): void;
  later(run: () => void, ms: number): void;
};

/** Save `blob` as `name`, and let the page's hold on it go once the
 * download surely has its own. */
export function saveDownload(
  host: DownloadHost,
  blob: Blob,
  name: string,
): void {
  const href = host.createObjectURL(blob);
  host.click(href, name);
  host.later(() => host.revokeObjectURL(href), DOWNLOAD_URL_KEEP_MS);
}

/** What the worker posts for a captured file. */
export type CapturedMessage =
  | { type: "status"; text: string }
  | { type: "snapshot-captured"; blob: Blob; ms: number };

/** The worker's announcement of a captured file: its status line first,
 * then the file -- so the page's own failure to save it, if any, comes
 * after the status and is the last word. */
export function postCaptured(
  post: (message: CapturedMessage) => void,
  blob: Blob,
  ms: number,
): void {
  post({
    type: "status",
    text: `snapshot captured (${blob.size} bytes); ` +
      "the sealed sandbox runs no Jupyter",
  });
  post({ type: "snapshot-captured", blob, ms });
}

/**
 * The program a capture runs (as root, in the guest's python3) to write
 * bytecode for the Python set: the login user cannot write __pycache__
 * there, so every start compiled the modules again. The directories are
 * the interpreter's own (sysconfig's stdlib and purelib), not a version's
 * path; none of them present, or a module that does not compile, is a
 * non-zero exit that fails the capture -- a snapshot without its bytecode
 * is not sealed.
 */
export const PRECOMPILE_PROGRAM = `
import compileall, os, sys, sysconfig
paths = sorted({sysconfig.get_path("stdlib"), sysconfig.get_path("purelib")})
present = [path for path in paths if os.path.isdir(path)]
if not present:
    sys.exit("no Python library directory to compile: " + ", ".join(paths))
compiled = [compileall.compile_dir(path, quiet=1) for path in present]
sys.exit(0 if all(compiled) else 1)
`;

/** The shell line that runs {@link PRECOMPILE_PROGRAM}. */
export function precompileLine(python = "sudo python3"): string {
  return `exec ${python} -c '${PRECOMPILE_PROGRAM.replace(/'/g, "'\\''")}'`;
}
