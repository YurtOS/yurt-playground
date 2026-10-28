/**
 * `?snapshot=capture`'s two page-side duties, apart from the DOM so they
 * can be tested: mark the capture's outcome where
 * scripts/release-snapshot.ts waits for it, and hand the captured file to
 * the browser as a download.
 */

/** Where the outcome is marked: `<html>`'s dataset in the page
 * (`data-snapshot-capture`, `data-snapshot-capture-error`). */
export type CaptureMark = {
  snapshotCapture?: string;
  snapshotCaptureError?: string;
};

/** The file was captured: whatever ends the boot after this is no
 * failure. */
export function markCaptured(mark: CaptureMark): void {
  mark.snapshotCapture = "captured";
}

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
  const named = mark.snapshotCaptureError !== undefined &&
    mark.snapshotCaptureError !== NO_SNAPSHOT;
  if (!named) mark.snapshotCaptureError = why ?? NO_SNAPSHOT;
}

/** The captured file arrived: save it, mark the capture, end the boot --
 * or, when saving throws, end the boot with that as the failure, so the
 * release script hears of it at once. */
export function finishCapture(
  mark: CaptureMark,
  save: () => void,
  endBoot: (why?: string) => void,
): void {
  try {
    save();
  } catch (error) {
    endBoot(
      `saving the snapshot failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return;
  }
  markCaptured(mark);
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
