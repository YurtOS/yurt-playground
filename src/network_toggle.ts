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
    script.onerror = () => reject(new Error("Turnstile did not load"));
    document.head.append(script);
  }).catch((error) => {
    turnstileScript = undefined;
    throw error;
  });
  return turnstileScript;
}

/** One Turnstile answer for `siteKey`, from a widget in `container` that
 * shows itself only if the visitor has to act. */
async function humanAnswer(
  siteKey: string,
  container: HTMLElement,
): Promise<string> {
  const turnstile = await loadTurnstile();
  const slot = document.createElement("div");
  container.append(slot);
  try {
    return await new Promise<string>((resolve, reject) => {
      const widget = turnstile.render(slot, {
        sitekey: siteKey,
        appearance: "interaction-only",
        callback: (token) => {
          turnstile.remove(widget);
          resolve(token);
        },
        "error-callback": (code) => {
          turnstile.remove(widget);
          reject(new Error(`Turnstile: ${code}`));
        },
      });
    });
  } finally {
    slot.remove();
  }
}

/** A relay token for the coordinator: a Turnstile answer, then `/token`. */
export async function relayToken(
  network: Network,
  container: HTMLElement,
  fetchFn: typeof fetch = fetch,
): Promise<{ token: string; expires: number }> {
  const human = await humanAnswer(network.siteKey, container);
  const response = await fetchFn(
    `${network.relay}/token?turnstile=${encodeURIComponent(human)}`,
    { credentials: "omit" },
  );
  if (!response.ok) throw new Error(`relay token: ${response.status}`);
  const { token, expires } = await response.json();
  return { token, expires };
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
  storage: Storage | undefined = globalThis.sessionStorage,
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
    remember(storage, on);
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
