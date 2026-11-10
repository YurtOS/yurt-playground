// The one place a Chromium-family acceptance test starts its browser.
//
// By default that is the installed Google Chrome (Playwright's "chrome"
// channel): the browser people run. Playwright's own headless Chromium is a
// different binary (chromium_headless_shell) several releases behind, and
// the playground has passed there while failing in Chrome (the notebook's
// "No Kernel", 2026-09-20). PLAYGROUND_BROWSER=chromium selects Playwright's
// pinned build instead, to reproduce a run from before the switch.
//
// The WebKit scene and the snapshot release scripts launch their own engine:
// a released snapshot is captured and checked in Playwright's pinned build,
// so its bytes do not move with a weekly Chrome update.
//
// Playwright is loaded when a browser starts, not on import: loading it needs
// --allow-sys, which the fast unit tests do not grant.
import type { Browser, LaunchOptions } from "playwright";

export type ChromiumBrowser = "chrome" | "chromium";

/** The browser PLAYGROUND_BROWSER names; Chrome when it is unset. */
export function selectedBrowser(
  value: string | undefined = Deno.env.get("PLAYGROUND_BROWSER"),
): ChromiumBrowser {
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
export async function launchBrowser(
  options: LaunchOptions = {},
): Promise<Browser> {
  const selected = selectedBrowser();
  const { chromium } = await import("playwright");
  const browser = await chromium.launch(launchOptions(selected, options));
  const name = selected === "chrome" ? "Google Chrome" : "Playwright Chromium";
  console.log(`browser: ${name} ${browser.version()}`);
  return browser;
}
