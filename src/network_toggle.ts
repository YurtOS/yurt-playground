/**
 * The terminal bar's network toggle (src/network.ts, #380): shown only
 * when src/network_config.ts names a relay, and off on every load but
 * one: the page's own reload that resumes a sealed sandbox (the agent's
 * runs), whose connections come back closed, turns it on again when it
 * was on. A refresh, a new tab, and a tab the browser duplicated or
 * opened (which copy sessionStorage) all start off.
 *
 * The page also gets the relay's tokens for the coordinator
 * ({@link relayToken}): each one needs a Turnstile answer, and Turnstile
 * runs in the page, not in a worker.
 */
import type { NetworkStatus } from "./network.ts";
import {
  type Network,
  NETWORK_CONFIG_PATH,
  networkOf,
  TURNSTILE_ACTION,
  TURNSTILE_ORIGIN,
} from "./network_config.ts";
import { siteUrl } from "./site_url.ts";

const WANTED_KEY = "yurt-network-on";

/** The configured network, or `undefined`: no network for the tab. */
export async function loadNetwork(
  fetchFn: typeof fetch = fetch,
): Promise<Network | undefined> {
  try {
    const response = await fetchFn(siteUrl(`./${NETWORK_CONFIG_PATH}`));
    if (!response.ok) return undefined;
    return networkOf(await response.json());
  } catch (error) {
    console.warn(`[network] no relay: ${error}`);
    return undefined;
  }
}

type Turnstile = {
  render(
    container: HTMLElement,
    options: {
      sitekey: string;
      action: string;
      appearance: "interaction-only";
      callback: (token: string) => void;
      "error-callback": (code: string) => void;
    },
  ): string;
  remove(widget: string): void;
};

let turnstileScript: Promise<Turnstile> | undefined;

/** Turnstile's script, loaded once. `crossorigin`: the page is
 * cross-origin isolated, so the script comes by CORS. */
function loadTurnstile(): Promise<Turnstile> {
  turnstileScript ??= new Promise<Turnstile>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = `${TURNSTILE_ORIGIN}/turnstile/v0/api.js?render=explicit`;
    script.crossOrigin = "anonymous";
    script.onload = () =>
      resolve((globalThis as unknown as { turnstile: Turnstile }).turnstile);
    script.onerror = () => {
      // Gone with its failure: the next try adds one tag, not another.
      script.remove();
      reject(new Error("Turnstile did not load"));
    };
    document.head.append(script);
  }).catch((error) => {
    turnstileScript = undefined;
    throw error;
  });
  return turnstileScript;
}

/** How long the page waits for a Turnstile answer: past it the widget
 * goes, and the token request fails. */
export const TURNSTILE_DEADLINE_MS = 60_000;

/** What `start` settles to, or a throw after `ms`. `start` returns its
 * clean-up, which runs either way. */
export function settleWithin<T>(
  start: (
    resolve: (value: T) => void,
    reject: (error: Error) => void,
  ) => () => void,
  ms: number,
): Promise<T> {
  let cleanUp = () => {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  return new Promise<T>((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer in ${ms} ms`)), ms);
    cleanUp = start(resolve, reject);
  }).finally(() => {
    clearTimeout(timer);
    cleanUp();
  });
}

/** `fn`, but a call while one is in flight gets that one's result. */
export function shareInFlight<T>(fn: () => Promise<T>): () => Promise<T> {
  let inFlight: Promise<T> | undefined;
  return () =>
    inFlight ??= fn().finally(() => {
      inFlight = undefined;
    });
}

/** One Turnstile answer for `siteKey`, from a widget in `container` that
 * shows itself only if the visitor has to act. */
async function humanAnswer(
  siteKey: string,
  container: HTMLElement,
): Promise<string> {
  const turnstile = await loadTurnstile();
  return await settleWithin<string>((resolve, reject) => {
    const slot = document.createElement("div");
    container.append(slot);
    const widget = turnstile.render(slot, {
      sitekey: siteKey,
      action: TURNSTILE_ACTION,
      appearance: "interaction-only",
      callback: resolve,
      "error-callback": (code) => reject(new Error(`Turnstile: ${code}`)),
    });
    return () => {
      turnstile.remove(widget);
      slot.remove();
    };
  }, TURNSTILE_DEADLINE_MS);
}

/** A relay token and its lifetime in seconds, for the coordinator: a
 * Turnstile answer, then `/token`. */
async function fetchRelayToken(
  network: Network,
  container: HTMLElement,
): Promise<{ token: string; ttl: number }> {
  const human = await humanAnswer(network.siteKey, container);
  const response = await fetch(
    `${network.relay}/token?turnstile=${encodeURIComponent(human)}`,
    { credentials: "omit" },
  );
  if (!response.ok) throw new Error(`relay token: ${response.status}`);
  const { token, ttl } = await response.json();
  return { token, ttl };
}

let pendingToken: (() => Promise<{ token: string; ttl: number }>) | undefined;

/** {@link fetchRelayToken}, one at a time: asked again while a check is in
 * flight, the page answers with that check's token, not a second widget. */
export function relayToken(
  network: Network,
  container: HTMLElement,
): Promise<{ token: string; ttl: number }> {
  pendingToken ??= shareInFlight(() => fetchRelayToken(network, container));
  return pendingToken();
}

/** Whether this load starts with the network on: only `ownReload` (the
 * page reloaded itself to resume its sandbox) after the user had turned it
 * on. Any other load forgets the choice. Off when storage cannot say. */
export function networkWanted(
  storage: Storage | undefined,
  ownReload: boolean,
): boolean {
  try {
    const wanted = storage?.getItem(WANTED_KEY) === "1";
    if (!ownReload) storage?.removeItem(WANTED_KEY);
    return ownReload && wanted;
  } catch {
    return false;
  }
}

function remember(storage: Storage | undefined, on: boolean): void {
  try {
    if (on) storage?.setItem(WANTED_KEY, "1");
    else storage?.removeItem(WANTED_KEY);
  } catch {
    // Not kept: a reload starts with the network off.
  }
}

export type NetworkControls = {
  /** The coordinator's latest status. */
  show(status: NetworkStatus): void;
};

/** Wire the bar's toggle, its count of open connections and its Cut
 * button to `send`, which posts to the coordinator. */
export function wireNetworkToggle(
  elements: {
    toggle: HTMLButtonElement;
    open: HTMLElement;
    cut: HTMLButtonElement;
    note: HTMLElement;
  },
  initiallyOn: boolean,
  send: (
    message: { type: "network"; on: boolean } | { type: "network-cut" },
  ) => void,
  /** Where the choice is kept for the page's own reload; null: nowhere. */
  storage: Storage | null = globalThis.sessionStorage,
): NetworkControls {
  const { toggle, open, cut, note } = elements;
  let on = initiallyOn;
  const render = (count: number) => {
    toggle.hidden = false;
    toggle.setAttribute("aria-pressed", String(on));
    toggle.textContent = on ? "Network: on (via Yurt relay)" : "Network: off";
    note.hidden = !on;
    open.hidden = !on;
    open.textContent = `${count} open`;
    cut.hidden = !on || count === 0;
  };
  toggle.onclick = () => {
    on = !on;
    remember(storage ?? undefined, on);
    send({ type: "network", on });
    render(0);
  };
  cut.onclick = () => send({ type: "network-cut" });
  render(0);
  return {
    show(status) {
      on = status.enabled;
      render(status.open);
    },
  };
}

/** Answer the coordinator's `network-token` request `req` on `worker`: a
 * Turnstile check in `container`, then `/token`; or why there is none. */
export function answerTokenRequest(
  worker: { postMessage(message: unknown): void },
  network: Promise<Network | undefined>,
  container: () => HTMLElement,
  req: number,
): void {
  void network.then(async (configured) => {
    if (configured === undefined) throw new Error("no relay");
    return await relayToken(configured, container());
  }).then(
    ({ token, ttl }) =>
      worker.postMessage({ type: "network-token-reply", req, token, ttl }),
    (error) => {
      console.warn(`[network] no token: ${error}`);
      worker.postMessage({
        type: "network-token-reply",
        req,
        error: String(error),
      });
    },
  );
}

/** The Notebook and JupyterLab pages' network controls: the frontend has
 * no bar for them, so a small fixed panel in the corner, built like the
 * bridge's status line (src/bridge_status.ts). Off on every load. */
export function mountNotebookNetwork(doc: Document): {
  toggle: HTMLButtonElement;
  open: HTMLElement;
  cut: HTMLButtonElement;
  note: HTMLElement;
  human: HTMLElement;
} {
  const panel = doc.createElement("div");
  panel.id = "yurt-network";
  panel.dataset.testid = "yurt-network";
  panel.style.cssText = [
    "position: fixed",
    "right: 12px",
    "bottom: 12px",
    "z-index: 10000",
    "max-width: min(420px, calc(100vw - 24px))",
    "display: flex",
    "flex-wrap: wrap",
    "align-items: center",
    "gap: 6px 10px",
    "padding: 6px 10px",
    "border-radius: 6px",
    "background: #1f2430",
    "color: #e6e1d7",
    "font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  ].join("; ");
  const button = (testid: string, text: string, title: string) => {
    const b = doc.createElement("button");
    b.type = "button";
    b.dataset.testid = testid;
    b.textContent = text;
    b.title = title;
    b.style.cssText =
      "font: inherit; color: inherit; background: none; border: 1px solid #5c6370; border-radius: 4px; padding: 1px 8px; cursor: pointer; white-space: nowrap";
    return b;
  };
  const toggle = button(
    "network-toggle",
    "Network: off",
    "Let programs in this notebook's sandbox reach the internet through Yurt's relay.",
  );
  toggle.setAttribute("aria-pressed", "false");
  const open = doc.createElement("span");
  open.dataset.testid = "network-open";
  open.hidden = true;
  const cut = button(
    "network-cut",
    "Cut connections",
    "Close every connection the sandbox has open.",
  );
  cut.hidden = true;
  const note = doc.createElement("p");
  note.dataset.testid = "network-note";
  note.hidden = true;
  note.style.cssText = "margin: 0; flex-basis: 100%";
  note.textContent = "Traffic leaves through Yurt's relay, which sees " +
    "destination names and how much data you send, not its contents (TLS " +
    "is end to end). Only ports 80, 443 and 9418, to public addresses; " +
    "never your local network.";
  const human = doc.createElement("div");
  human.dataset.testid = "network-human";
  panel.append(toggle, open, cut, note, human);
  doc.body.append(panel);
  return { toggle, open, cut, note, human };
}
