// The one place a Chromium-family acceptance test starts its browser: the
// installed Google Chrome (Playwright's "chrome" channel), the browser people
// run, not Playwright's headless Chromium build. PLAYGROUND_BROWSER=chromium
// selects that build (after `playwright install chromium`).
//
// Playwright is loaded when a browser starts, not on import: loading it needs
// --allow-sys, which the fast unit tests do not grant.
import type { Browser, BrowserContext, LaunchOptions } from "playwright";

export type ChromiumBrowser = "chrome" | "chromium";

/** A PLAYGROUND_BROWSER value's browser; Chrome when it is unset. */
export function parseBrowser(value: string | undefined): ChromiumBrowser {
  if (value === undefined || value === "" || value === "chrome") {
    return "chrome";
  }
  if (value === "chromium") return "chromium";
  throw new Error(
    `PLAYGROUND_BROWSER=${value}: expected "chrome" or "chromium"`,
  );
}

/** Launch options for `browser`: the chrome channel, or Playwright's build. */
export function launchOptions(
  browser: ChromiumBrowser,
  options: LaunchOptions = {},
): LaunchOptions {
  return browser === "chrome" ? { ...options, channel: "chrome" } : options;
}

/** Launch the selected browser and print which one, with its version. */
export async function launchBrowser(): Promise<Browser> {
  const selected = parseBrowser(Deno.env.get("PLAYGROUND_BROWSER"));
  const { chromium } = await import("playwright");
  const browser = await chromium.launch(launchOptions(selected));
  const name = selected === "chrome" ? "Google Chrome" : "Playwright Chromium";
  console.log(`browser: ${name} ${browser.version()}`);
  return browser;
}

/** The selected browser's default profile (a fresh one) with the unpacked
 *  extension at `extension` loaded: an extension runs only there, not in
 *  the incognito-like contexts `Browser.newContext` makes. Chrome dropped
 *  `--load-extension`; DevTools' `Extensions.loadUnpacked`, behind
 *  `--enable-unsafe-extension-debugging`, is how a test loads one. */
export async function launchWithExtension(
  extension: string,
): Promise<BrowserContext> {
  const selected = parseBrowser(Deno.env.get("PLAYGROUND_BROWSER"));
  const { chromium } = await import("playwright");
  const profile = await Deno.makeTempDir({ prefix: "yurt-extension-" });
  const context = await chromium.launchPersistentContext(
    profile,
    launchOptions(selected, {
      headless: true,
      ignoreDefaultArgs: ["--disable-extensions"],
      args: ["--enable-unsafe-extension-debugging"],
    }),
  );
  const browser = context.browser()!;
  console.log(`browser: ${selected} ${browser.version()}`);
  const cdp = await browser.newBrowserCDPSession();
  const { id } = await cdp.send(
    "Extensions.loadUnpacked" as never,
    { path: extension } as never,
  ) as { id: string };
  console.log(`extension: ${id}`);
  return context;
}
