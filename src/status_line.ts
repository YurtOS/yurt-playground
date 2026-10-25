/**
 * The terminal bar's status line (`#status`) has two writers: the boot's
 * progress ("loading", "starting Jupyter (35 s)", every 5 s) and the
 * outcome of something the reader did (Download home, Upload). Progress
 * must not bury an outcome: a "download home failed" was written over by
 * the next Jupyter tick within seconds. So an outcome holds the line:
 *
 * - a failed action's message stays until the next outcome or a failure
 *   of the sandbox itself;
 * - a successful one stays for `holdMs`, then the latest progress is shown.
 *
 * A boot failure (`failure`) always takes the line.
 */
export type StatusLine = {
  /** The boot's progress, or its settled state ("running"). */
  progress(text: string): void;
  /** The outcome of a reader's action. */
  notice(text: string, options?: { error?: boolean }): void;
  /** The sandbox (or its Jupyter) failed: shown at once, over anything. */
  failure(text: string): void;
};

/** How long a successful action's message holds the line against progress. */
export const NOTICE_HOLD_MS = 15_000;

export function createStatusLine(
  element: { textContent: string | null },
  options: {
    holdMs?: number;
    setTimer?: (run: () => void, ms: number) => unknown;
    clearTimer?: (timer: unknown) => void;
  } = {},
): StatusLine {
  const holdMs = options.holdMs ?? NOTICE_HOLD_MS;
  const setTimer = options.setTimer ??
    ((run: () => void, ms: number) => setTimeout(run, ms));
  const clearTimer = options.clearTimer ??
    ((timer: unknown) => clearTimeout(timer as number));
  /** The progress the line would show if no notice held it. */
  let latest: string | undefined;
  let held: "error" | "timed" | undefined;
  let timer: unknown;
  const release = () => {
    if (timer !== undefined) clearTimer(timer);
    timer = undefined;
    held = undefined;
  };
  return {
    progress(text) {
      latest = text;
      if (held === undefined) element.textContent = text;
    },
    notice(text, { error = false } = {}) {
      release();
      element.textContent = text;
      held = error ? "error" : "timed";
      if (!error) {
        timer = setTimer(() => {
          timer = undefined;
          held = undefined;
          if (latest !== undefined) element.textContent = latest;
        }, holdMs);
      }
    },
    failure(text) {
      release();
      latest = text;
      element.textContent = text;
    },
  };
}
