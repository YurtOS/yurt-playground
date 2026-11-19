/**
 * Where the in-tab sandbox's network relay is (src/network.ts, #380): the
 * one setting, {@link NETWORK_RELAY}. The build ships it beside the page as
 * config/network.json, which the page reads, and the policy (src/csp.ts)
 * admits it. Null -- until a relay is deployed -- means the tab has no
 * network and shows no toggle.
 */

/** The relay's base URL (`https://…`), or null: no network for the tab. */
export const NETWORK_RELAY: string | null = null;

export type NetworkConfig = {
  /** The relay's base URL (`https://…`), or null. */
  relay: string | null;
};

export const NETWORK_CONFIG_PATH = "config/network.json";

/** The relay's origin, or `undefined` when `config` names none. Throws on
 * a relay that is not an http(s) URL. */
export function relayOf(config: unknown): string | undefined {
  const relay = (config as Partial<NetworkConfig> | null)?.relay;
  if (relay === null || relay === undefined) return undefined;
  if (typeof relay !== "string") throw new Error("network relay: not a URL");
  const url = new URL(relay);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`network relay ${relay}: not an http(s) URL`);
  }
  return url.origin;
}

/** The relay this build ships, if any. */
export const CONFIGURED_RELAY: string | undefined = relayOf({
  relay: NETWORK_RELAY,
});

/** config/network.json as the build and the local servers ship it. */
export function networkConfigJson(): string {
  return JSON.stringify({ relay: NETWORK_RELAY } satisfies NetworkConfig);
}

/** What `connect-src` needs for `relay`: its origin for `/token` and
 * `/dns`, and the same host's WebSocket scheme for `/tcp`. */
export function relaySources(relay: string): string[] {
  const url = new URL(relay);
  return [
    url.origin,
    `${url.protocol === "https:" ? "wss:" : "ws:"}//${url.host}`,
  ];
}
