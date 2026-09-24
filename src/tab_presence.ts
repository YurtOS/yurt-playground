/**
 * Whether another tab of this site already runs a sandbox. Two in one
 * browser share the CPU: a second boot next to a running one took 140 s
 * where the first took 27, and the page said nothing about why
 * (yurt-playground#84). A tab with a sandbox answers the others' question
 * over one BroadcastChannel per name in this tab; there is no cross-tab
 * state to keep, only tabs to ask.
 */

const CHANNEL = "yurt-playground-sandbox";

type Presence = { type: "who" } | { type: "here" };

/** A browser with cross-origin isolation but no BroadcastChannel (Safari
 * 15.2-15.3) boots without the question; the channel is a courtesy. */
const supported = typeof BroadcastChannel !== "undefined";

type SharedChannel = { channel: BroadcastChannel; listeners: number };
const channels = new Map<string, SharedChannel>();

function listen(
  name: string,
  handler: (event: MessageEvent<Presence>) => void,
): { channel: BroadcastChannel; stop: () => void } {
  let shared = channels.get(name);
  if (shared === undefined) {
    shared = { channel: new BroadcastChannel(name), listeners: 0 };
    channels.set(name, shared);
  }
  const entry = shared;
  entry.listeners++;
  entry.channel.addEventListener("message", handler);
  let stopped = false;
  return {
    channel: entry.channel,
    stop: () => {
      if (stopped) return;
      stopped = true;
      entry.channel.removeEventListener("message", handler);
      if (--entry.listeners === 0) {
        entry.channel.close();
        channels.delete(name);
      }
    },
  };
}

/** Answer "who has a sandbox?" until the returned function is called. */
export function announceSandbox(name = CHANNEL): () => void {
  if (!supported) return () => {};
  const listener = listen(name, (event) => {
    if (event.data?.type === "who") {
      listener.channel.postMessage({ type: "here" });
    }
  });
  return listener.stop;
}

/** Ask, and wait up to `timeoutMs` for another tab to say it has one. */
export function anotherSandboxRunning(
  timeoutMs = 300,
  name = CHANNEL,
): Promise<boolean> {
  if (!supported) return Promise.resolve(false);
  return new Promise((resolve) => {
    let settled = false;
    let stopListening = () => {};
    let cancelTimeout = () => {};
    const done = (answer: boolean) => {
      if (settled) return;
      settled = true;
      cancelTimeout();
      stopListening();
      resolve(answer);
    };
    const listener = listen(name, (event) => {
      if (event.data?.type === "here") done(true);
    });
    stopListening = listener.stop;
    const timer = setTimeout(() => done(false), timeoutMs);
    cancelTimeout = () => clearTimeout(timer);
    listener.channel.postMessage({ type: "who" });
  });
}

/** Show a warning while a neighbour answers; return one stop for the whole
 * initial probe and follow-up watcher lifecycle. */
export function watchForAnotherSandbox(
  show: () => void,
  hide: () => void,
  options: { intervalMs?: number; name?: string; timeoutMs?: number } = {},
): () => void {
  const { intervalMs = 5000, name = CHANNEL, timeoutMs = 300 } = options;
  let stopped = false;
  let visible = false;
  let stopWatching = () => {};
  const hideOnce = () => {
    if (!visible) return;
    visible = false;
    hide();
  };
  void anotherSandboxRunning(timeoutMs, name).then((another) => {
    if (!another || stopped) return;
    visible = true;
    show();
    stopWatching = whileAnotherSandboxRuns(
      hideOnce,
      intervalMs,
      name,
      timeoutMs,
    );
  });
  return () => {
    if (stopped) return;
    stopped = true;
    stopWatching();
    hideOnce();
  };
}

/**
 * Keep asking, and say when nobody answers any more.
 *
 * The note the first answer raises tells the reader to close the other tab,
 * and used to keep contradicting them once they had (yurt-playground#134).
 * `gone` is called at most once, after `silentRounds` consecutive rounds
 * with no answer, and the asking stops there: a neighbour that comes back
 * later does not slow this tab's boot, which is what the note was about.
 */
export function whileAnotherSandboxRuns(
  gone: () => void,
  intervalMs = 5000,
  name = CHANNEL,
  timeoutMs = 300,
  /** Rounds of silence before the neighbour is believed gone. One is not
   * enough: the answer needs the *other* tab's main thread, and that tab
   * is busy by definition -- it is the reason the note is up. A single
   * long task there, or Chrome throttling a hidden tab, would otherwise
   * erase a warning that is still true, with no way back. */
  silentRounds = 3,
): () => void {
  if (!supported) return () => {};
  let timer = 0;
  let silent = 0;
  // `clearInterval` cannot cancel a probe already in flight, and `gone`
  // must be called at most once however many overlap.
  let stopped = false;
  const stop = () => {
    stopped = true;
    clearInterval(timer);
  };
  timer = setInterval(async () => {
    const another = await anotherSandboxRunning(timeoutMs, name);
    if (stopped) return;
    if (another) {
      silent = 0;
      return;
    }
    if (++silent < silentRounds) return;
    stop();
    gone();
  }, intervalMs);
  return stop;
}
