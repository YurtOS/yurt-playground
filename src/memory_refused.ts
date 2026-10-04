/**
 * The browser refused a new process its memory (yurtos-kernel#2996).
 *
 * A browser caps the shared wasm memory a tab may reserve (WebKit at about
 * 32 GiB; Chrome and Firefox refuse with a RangeError too once their own
 * limit is reached), and memory freed by processes that exited comes back
 * only after garbage collection. Past the cap every new process fails: the
 * shell says `can't fork`, and nothing in the sandbox can fix it. The
 * kernel's JS host reports each refusal (`onGuestMemoryRefused`); a guest
 * that only hit its own memory limit is an ordinary ENOMEM and is not
 * reported. Reloading the page frees it all. The page's banner
 * (`#memory-refused` in index.html) names no engine: every engine can refuse.
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
  // `unknown`, not `RefusalSource`: a KernelHostInterface without the hook
  // (the pinned kernel until #3116 ships) shares no member with that weak
  // type, so passing one is a type error (TS2559).
  const source = host as RefusalSource;
  if (typeof source.onGuestMemoryRefused !== "function") return;
  let told = false;
  let subscribed = false;
  const unsubscribe = source.onGuestMemoryRefused(() => {
    if (told) return;
    told = true;
    notify();
    // A refusal reported during the subscription itself has no handle to
    // drop yet; it is dropped below, once the call returns.
    if (subscribed) unsubscribe();
  });
  subscribed = true;
  if (told) unsubscribe();
}
