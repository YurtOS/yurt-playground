/**
 * Whether another tab of this site already runs a sandbox. Two in one
 * browser share the CPU: a second boot next to a running one took 140 s
 * where the first took 27, and the page said nothing about why
 * (yurt-playground#84). A tab with a sandbox answers the others' question
 * over a BroadcastChannel; there is no shared state to keep, only tabs to
 * ask.
 */

const CHANNEL = "yurt-playground-sandbox";

type Presence = { type: "who" } | { type: "here" };

/** A browser with cross-origin isolation but no BroadcastChannel (Safari
 * 15.2-15.3) boots without the question; the channel is a courtesy. */
const supported = typeof BroadcastChannel !== "undefined";

/** Answer "who has a sandbox?" until the returned function is called. */
export function announceSandbox(name = CHANNEL): () => void {
  if (!supported) return () => {};
  const channel = new BroadcastChannel(name);
  channel.onmessage = (event: MessageEvent<Presence>) => {
    if (event.data?.type === "who") channel.postMessage({ type: "here" });
  };
  return () => channel.close();
}

/** Ask, and wait up to `timeoutMs` for any tab to say it has one. */
export function anotherSandboxRunning(
  timeoutMs = 300,
  name = CHANNEL,
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
      if (event.data?.type === "here") done(true);
    };
    channel.postMessage({ type: "who" });
  });
}
