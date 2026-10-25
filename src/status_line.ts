/**
 * The terminal bar's status line (`#status`) has two writers: the boot's
 * progress ("loading", "starting Jupyter (35 s)", every 5 s) and the
 * outcome of something the reader did (Download home, Upload). Progress
 * must not bury an outcome: a "download home failed" was written over by
 * the next Jupyter tick within seconds. So an outcome holds the line:
 *
 * - a failed action's message stays until the next outcome, a failure of
 *   the sandbox itself, the boot settling, or `errorHoldMs`;
 * - a successful one stays for `holdMs`, then the latest progress is shown.
 *
 * A boot failure (`failure`) always takes the line.
 */
export type StatusLine = {
  /** The boot's progress. `settled`: the boot is over ("running"), which
   * also releases an action's error held from during the boot. */
  progress(text: string, options?: { settled?: boolean }): void;
  /** The outcome of a reader's action. */
  notice(text: string, options?: { error?: boolean }): void;
  /** The sandbox (or its Jupyter) failed: shown at once, over anything. */
  failure(text: string): void;
};

/** How long a successful action's message holds the line against progress. */
export const NOTICE_HOLD_MS = 15_000;
/** How long a failed action's message holds it at most. */
export const ERROR_HOLD_MS = 120_000;

export function createStatusLine(
  element: { textContent: string | null },
  options: {
    holdMs?: number;
    errorHoldMs?: number;
    setTimer?: (run: () => void, ms: number) => unknown;
    clearTimer?: (timer: unknown) => void;
  } = {},
): StatusLine {
  const holdMs = options.holdMs ?? NOTICE_HOLD_MS;
  const errorHoldMs = options.errorHoldMs ?? ERROR_HOLD_MS;
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
    progress(text, { settled = false } = {}) {
      latest = text;
      if (settled) release();
      if (held === undefined) element.textContent = text;
    },
    notice(text, { error = false } = {}) {
      release();
      element.textContent = text;
      held = error ? "error" : "timed";
      timer = setTimer(() => {
        timer = undefined;
        held = undefined;
        if (latest !== undefined) element.textContent = latest;
      }, error ? errorHoldMs : holdMs);
    },
    failure(text) {
      release();
      latest = text;
      element.textContent = text;
    },
  };
}
