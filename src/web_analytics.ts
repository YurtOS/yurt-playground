/**
 * Cloudflare Web Analytics (cookieless page views) for the deployed site.
 *
 * The site is static, so Pages Functions metrics see nothing; the beacon is
 * the only visitor count. Only `scripts/build-static.ts --web-analytics`
 * injects it, and only the production deploy (deploy-pages.yml) passes
 * that, so previews, local serving, CI e2e and the desktop app report
 * nothing. It is inert while {@link WEB_ANALYTICS_TOKEN} is empty: no
 * snippet and no extra CSP sources.
 *
 * Do not also turn on the Pages project's automatic Web Analytics in the
 * Cloudflare dashboard: it would count every view twice, and the snippet
 * Cloudflare injects at the edge is not in the CSP. The beacon script answers with `cross-origin-resource-policy:
 * cross-origin` and its report endpoint answers CORS, so it loads under the
 * site's COEP `require-corp`.
 */

/** The site's public beacon token (not a secret); empty disables the beacon. */
export const WEB_ANALYTICS_TOKEN = "";

/** Where the beacon script loads from (`script-src`). */
export const BEACON_SCRIPT_ORIGIN = "https://static.cloudflareinsights.com";
/** Where the beacon reports to (`connect-src`). */
export const BEACON_REPORT_ORIGIN = "https://cloudflareinsights.com";

/** The built pages that carry the beacon: the home page, the demo page and
 * the unsupported-browser page. Not 404.html (noindex), terminal.html (an
 * instant redirect to the home page), memory-probe.html (a diagnostic) or
 * the JupyterLite site. */
export const BEACON_PAGES = ["index.html", "snapshot.html", "unsupported.html"];

/** The beacon's `<script>` tag for `token`. */
export function beaconSnippet(token: string): string {
  if (!/^[A-Za-z0-9]+$/.test(token)) {
    throw new Error(
      `web analytics token ${JSON.stringify(token)} is malformed`,
    );
  }
  return `<script defer src="${BEACON_SCRIPT_ORIGIN}/beacon.min.js" ` +
    `data-cf-beacon='{"token": "${token}"}'></script>`;
}

/** `html` with the beacon before its `</head>`; unchanged for an empty token. */
export function withBeacon(html: string, token: string): string {
  if (token === "") return html;
  const head = html.indexOf("</head>");
  if (head < 0) throw new Error("page has no </head> for the beacon");
  return html.slice(0, head) + `${beaconSnippet(token)}\n  ` +
    html.slice(head);
}
