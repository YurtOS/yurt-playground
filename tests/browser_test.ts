import { assertEquals, assertThrows } from "@std/assert";
import { launchOptions, selectedBrowser } from "./browser.ts";

Deno.test("acceptance runs Google Chrome unless PLAYGROUND_BROWSER says chromium", () => {
  assertEquals(selectedBrowser(undefined), "chrome");
  assertEquals(selectedBrowser(""), "chrome");
  assertEquals(selectedBrowser("chrome"), "chrome");
  assertEquals(selectedBrowser("chromium"), "chromium");
  // A typo fails the run instead of quietly testing some other browser.
  assertThrows(() => selectedBrowser("Chrome"), Error, "PLAYGROUND_BROWSER");
  assertThrows(() => selectedBrowser("webkit"), Error, "PLAYGROUND_BROWSER");
});

Deno.test("chrome launches through Playwright's chrome channel; chromium through its own build", () => {
  assertEquals(launchOptions("chrome"), { channel: "chrome" });
  assertEquals(launchOptions("chrome", { headless: false }), {
    headless: false,
    channel: "chrome",
  });
  assertEquals(launchOptions("chromium"), {});
  assertEquals(launchOptions("chromium", { headless: false }), {
    headless: false,
  });
});

Deno.test("every Chromium-family acceptance test starts its browser through tests/browser.ts", async () => {
  // A direct chromium.launch() would run Playwright's headless Chromium, not
  // the Chrome people use. Persistent contexts (agent_demo, agent_webgpu)
  // already name the chrome channel. The release scripts stay on the pinned
  // build on purpose (see tests/browser.ts).
  const offenders: string[] = [];
  for await (const entry of Deno.readDir(new URL(".", import.meta.url))) {
    if (!entry.isFile || !entry.name.endsWith(".ts")) continue;
    if (entry.name === "browser.ts" || entry.name === "browser_test.ts") {
      continue;
    }
    const text = await Deno.readTextFile(new URL(entry.name, import.meta.url));
    if (/\bchromium\.launch\(/.test(text)) offenders.push(entry.name);
    if (
      /\bchromium\.launchPersistentContext\(/.test(text) &&
      !text.includes('channel: "chrome"')
    ) offenders.push(entry.name);
  }
  assertEquals(offenders.sort(), []);
});
