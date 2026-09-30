/**
 * The browser refused a new process its memory (yurtos-kernel#2996).
 *
 * WebKit caps the shared wasm memory a tab may reserve, and memory freed by
 * processes that exited comes back only after garbage collection. Past the
 * cap every new process fails: the shell says `can't fork`, and nothing in
 * the sandbox can fix it. The kernel's JS host reports each refusal
 * (`onGuestMemoryRefused`); a guest that only hit its own memory limit is an
 * ordinary ENOMEM and is not reported. Reloading the page frees it all.
 */

type RefusalSource = {
  onGuestMemoryRefused?: (listener: () => void) => () => void;
};

/**
 * Call `notify` once, on the first refusal. A kernel older than the hook
 * has no `onGuestMemoryRefused`, and then nothing is ever reported.
 */
export function watchGuestMemoryRefusals(
  host: unknown,
  notify: () => void,
): void {
  const source = host as RefusalSource;
  if (typeof source.onGuestMemoryRefused !== "function") return;
  let told = false;
  const unsubscribe = source.onGuestMemoryRefused(() => {
    if (told) return;
    told = true;
    notify();
    unsubscribe();
  });
}

/** What the page says, naming Safari where that is the browser. */
export function memoryRefusedMessage(userAgent: string): string {
  const safari = /AppleWebKit\//.test(userAgent) &&
    !/(Chrome|Chromium|CriOS|Edg|FxiOS)\//.test(userAgent);
  return `${
    safari ? "Safari" : "The browser"
  } ran out of memory for new processes. Reload the page to continue.`;
}
