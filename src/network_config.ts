/**
 * Where the in-tab sandbox's network relay is (src/network.ts, #380), and
 * the Turnstile widget a page passes before the relay gives it a token:
 * the two settings, {@link NETWORK_RELAY} and {@link TURNSTILE_SITE_KEY}.
 * The build ships them beside the page as config/network.json, which the
 * page reads, and the policy (src/csp.ts) admits the relay and Turnstile.
 * A null relay -- until one is deployed -- means the tab has no network
 * and shows no toggle.
 */

/** The relay's base URL (`https://…`), or null: no network for the tab. */
export const NETWORK_RELAY: string | null = null;
/** The relay's Turnstile widget's site key; required with a relay. */
export const TURNSTILE_SITE_KEY: string | null = null;

/** The action the widget runs; the relay checks siteverify reports it. */
export const TURNSTILE_ACTION = "relay-token";

/** Where Turnstile's script and challenge frame come from. */
export const TURNSTILE_ORIGIN = "https://challenges.cloudflare.com";

export type NetworkConfig = {
  /** The relay's base URL (`https://…`), or null. */
  relay: string | null;
  turnstileSiteKey: string | null;
};

/** A configured network: the relay's origin and the widget's site key. */
export type Network = { relay: string; siteKey: string };

export const NETWORK_CONFIG_PATH = "config/network.json";

/** The network `config` names, or `undefined` when it names no relay.
 * Throws on a relay that is not an http(s) URL, or one without a site
 * key. */
export function networkOf(config: unknown): Network | undefined {
  const { relay, turnstileSiteKey } = (config ?? {}) as Partial<NetworkConfig>;
  if (relay === null || relay === undefined) return undefined;
  if (typeof relay !== "string") throw new Error("network relay: not a URL");
  const url = new URL(relay);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`network relay ${relay}: not an http(s) URL`);
  }
  if (typeof turnstileSiteKey !== "string" || turnstileSiteKey === "") {
    throw new Error("network relay: no Turnstile site key");
  }
  return { relay: url.origin, siteKey: turnstileSiteKey };
}

/** The relay this build ships, if any. */
export const CONFIGURED_RELAY: string | undefined = networkOf({
  relay: NETWORK_RELAY,
  turnstileSiteKey: TURNSTILE_SITE_KEY,
})?.relay;

/** config/network.json as the build and the local servers ship it. */
export function networkConfigJson(): string {
  return JSON.stringify(
    {
      relay: NETWORK_RELAY,
      turnstileSiteKey: TURNSTILE_SITE_KEY,
    } satisfies NetworkConfig,
  );
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
