/**
 * Whether another tab of this site already runs a sandbox. Two in one
 * browser share the CPU: a second boot next to a running one took 140 s
 * where the first took 27, and the page said nothing about why
 * (yurt-playground#84). A tab with a sandbox answers the others' question
 * over a BroadcastChannel; there is no shared state to keep, only tabs to
 * ask.
 */

const CHANNEL = "yurt-playground-sandbox";

type Presence = { type: "who" } | { type: "here"; from: string };

/** A browser with cross-origin isolation but no BroadcastChannel (Safari
 * 15.2-15.3) boots without the question; the channel is a courtesy. */
const supported = typeof BroadcastChannel !== "undefined";

/**
 * This tab, for telling its own answer apart from a neighbour's.
 *
 * A BroadcastChannel delivers to every *other* channel object, including
 * the ones this tab holds: once it announces its own sandbox, asking again
 * hears itself. The first ask happens before the announcement so it never
 * noticed; the watcher below asks afterwards and would never see a
 * neighbour leave (yurt-playground#134).
 */
const SELF = `${Date.now()}-${Math.random()}`;

/** Answer "who has a sandbox?" until the returned function is called. */
export function announceSandbox(name = CHANNEL, from = SELF): () => void {
  if (!supported) return () => {};
  const channel = new BroadcastChannel(name);
  channel.onmessage = (event: MessageEvent<Presence>) => {
    if (event.data?.type === "who") channel.postMessage({ type: "here", from });
  };
  return () => channel.close();
}

/** Ask, and wait up to `timeoutMs` for another tab to say it has one.
 *  Answers from `ignore` -- this tab, by default -- do not count. */
export function anotherSandboxRunning(
  timeoutMs = 300,
  name = CHANNEL,
  ignore = SELF,
): Promise<boolean> {
  if (!supported) return Promise.resolve(false);
  return new Promise((resolve) => {
    const channel = new BroadcastChannel(name);
    const done = (answer: boolean) => {
      clearTimeout(timer);
      channel.close();
      resolve(answer);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    channel.onmessage = (event: MessageEvent<Presence>) => {
      if (event.data?.type === "here" && event.data.from !== ignore) done(true);
    };
    channel.postMessage({ type: "who" });
  });
}

/**
 * Keep asking, and say when nobody answers any more.
 *
 * The note the first answer raises tells the reader to close the other tab,
 * and used to keep contradicting them once they had (yurt-playground#134).
 * `gone` is called at most once, on the first round with no answer, and the
 * asking stops there: a neighbour that comes back later does not slow this
 * tab's boot, which is what the note was about.
 */
export function whileAnotherSandboxRuns(
  gone: () => void,
  intervalMs = 5000,
  name = CHANNEL,
  timeoutMs = 300,
  ignore = SELF,
): () => void {
  if (!supported) return () => {};
  let timer = 0;
  const stop = () => clearInterval(timer);
  timer = setInterval(async () => {
    if (await anotherSandboxRunning(timeoutMs, name, ignore)) return;
    stop();
    gone();
  }, intervalMs);
  return stop;
}
