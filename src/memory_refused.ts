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
 *
 * Every page that boots a kernel shows it: the main page from its static
 * banner, and the snapshot demo and both JupyterLite notebook kernels from
 * `mountMemoryRefusedBanner` (yurt-playground#213).
 */

type RefusalSource = {
  onGuestMemoryRefused?: (listener: () => void) => () => void;
};

/** The coordinator's message to the page, and the page's banner and its
 *  Reload button (`public/index.html`). One place names all three, so the
 *  wiring test can check them against each other. */
export const MEMORY_REFUSED_MESSAGE_TYPE = "memory-refused";
export const MEMORY_REFUSED_BANNER_ID = "memory-refused";
export const MEMORY_REFUSED_RELOAD_ID = "memory-refused-reload";
/** The banner's words; index.html's static banner says the same. */
export const MEMORY_REFUSED_TEXT =
  "The browser ran out of memory for new processes. Reload the page to continue.";

export type MemoryRefusedMessage = {
  type: typeof MEMORY_REFUSED_MESSAGE_TYPE;
};

/** What the coordinator posts when the kernel reports a refusal. */
export function memoryRefusedMessage(): MemoryRefusedMessage {
  return { type: MEMORY_REFUSED_MESSAGE_TYPE };
}

type Banner = { hidden: boolean };

/** Page side: show the banner for a refusal message; other messages are
 *  ignored. */
export function showMemoryRefused(
  message: { type: string },
  byId: (id: string) => Banner,
): void {
  if (message.type === MEMORY_REFUSED_MESSAGE_TYPE) {
    byId(MEMORY_REFUSED_BANNER_ID).hidden = false;
  }
}

/** Fixed to the top: JupyterLite lays its shell out over the whole body, so
 *  an element in the flow would sit behind it. The colours are index.html's
 *  `--ember` and `--pane`. */
const MOUNTED_BANNER_STYLE = [
  "position: fixed",
  "top: 0",
  "left: 0",
  "right: 0",
  "z-index: 10000",
  "margin: 0",
  "padding: 12px 14px",
  "border-left: 3px solid #e08a7a",
  "background: #1c212a",
  "color: #e6e1d7",
  "font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
].join("; ");

/**
 * Page side, for a page without index.html's static banner: show the same
 * banner, built on the first refusal and found again on any later one.
 * Reload is the only way out, so the banner has no close control.
 */
export function mountMemoryRefusedBanner(
  doc: Document,
  reload: () => void = () => location.reload(),
): HTMLElement {
  const existing = doc.getElementById(MEMORY_REFUSED_BANNER_ID);
  if (existing !== null) {
    existing.hidden = false;
    return existing;
  }
  const banner = doc.createElement("p");
  banner.id = MEMORY_REFUSED_BANNER_ID;
  banner.dataset.testid = MEMORY_REFUSED_BANNER_ID;
  banner.setAttribute("role", "alert");
  banner.style.cssText = MOUNTED_BANNER_STYLE;
  banner.textContent = `${MEMORY_REFUSED_TEXT} `;
  const button = doc.createElement("button");
  button.type = "button";
  button.id = MEMORY_REFUSED_RELOAD_ID;
  button.dataset.testid = MEMORY_REFUSED_RELOAD_ID;
  button.textContent = "Reload";
  button.addEventListener("click", () => reload());
  banner.append(button);
  doc.body.prepend(banner);
  return banner;
}

/** Page side: a new session starts without the banner. */
export function hideMemoryRefused(byId: (id: string) => Banner): void {
  byId(MEMORY_REFUSED_BANNER_ID).hidden = true;
}

/**
 * Call `notify` once, on the first refusal. A kernel older than the hook
 * has no `onGuestMemoryRefused`, and then nothing is ever reported. Returns
 * a function that stops watching (the session is stopping); calling it
 * again, or after the first refusal, does nothing.
 */
export function watchGuestMemoryRefusals(
  host: unknown,
  notify: () => void,
): () => void {
  // `unknown`, not `RefusalSource`: a KernelHostInterface without the hook
  // (the pinned kernel until #3116 ships) shares no member with that weak
  // type, so passing one is a type error (TS2559).
  const source = host as RefusalSource;
  if (typeof source.onGuestMemoryRefused !== "function") return () => {};
  let told = false;
  let subscribed = false;
  let done = false;
  const stop = () => {
    if (done) return;
    done = true;
    unsubscribe();
  };
  const unsubscribe = source.onGuestMemoryRefused(() => {
    if (told || done) return;
    told = true;
    notify();
    // A refusal reported during the subscription itself has no handle to
    // drop yet; it is dropped below, once the call returns.
    if (subscribed) stop();
  });
  subscribed = true;
  if (told) stop();
  return stop;
}
