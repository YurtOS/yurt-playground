/**
 * The terminal bar's network toggle (src/network.ts, #380): shown only
 * when src/network_config.ts names a relay, off on every new tab. The
 * choice is kept for the tab (sessionStorage), so a reload that resumes
 * the sandbox -- whose connections come back closed -- turns it on again.
 */
import type { NetworkStatus } from "./network.ts";
import { NETWORK_CONFIG_PATH, relayOf } from "./network_config.ts";
import { siteUrl } from "./site_url.ts";

const WANTED_KEY = "yurt-network-on";

/** The configured relay's origin, or `undefined`: no network for the tab. */
export async function loadNetworkRelay(
  fetchFn: typeof fetch = fetch,
): Promise<string | undefined> {
  try {
    const response = await fetchFn(siteUrl(`./${NETWORK_CONFIG_PATH}`));
    if (!response.ok) return undefined;
    return relayOf(await response.json());
  } catch (error) {
    console.warn(`[network] no relay: ${error}`);
    return undefined;
  }
}

/** Whether this tab's user turned the network on (and has not since
 * turned it off). Off when storage cannot say. */
export function networkWanted(storage: Storage | undefined): boolean {
  try {
    return storage?.getItem(WANTED_KEY) === "1";
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
