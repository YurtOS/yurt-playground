import { assertEquals, assertThrows } from "@std/assert";
import { launchOptions, parseBrowser } from "./browser.ts";

Deno.test("acceptance runs Google Chrome unless PLAYGROUND_BROWSER says chromium", () => {
  assertEquals(parseBrowser(undefined), "chrome");
  assertEquals(parseBrowser(""), "chrome");
  assertEquals(parseBrowser("chrome"), "chrome");
  assertEquals(parseBrowser("chromium"), "chromium");
  // A typo fails the run instead of quietly testing some other browser.
  assertThrows(() => parseBrowser("Chrome"), Error, "PLAYGROUND_BROWSER");
  assertThrows(() => parseBrowser("webkit"), Error, "PLAYGROUND_BROWSER");
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

/** Every `.ts` file under `dir`, recursively, as paths relative to it. */
async function tsFiles(dir: URL, prefix = ""): Promise<string[]> {
  const files: string[] = [];
  for await (const entry of Deno.readDir(dir)) {
    if (entry.isDirectory) {
      files.push(
        ...await tsFiles(
          new URL(`${entry.name}/`, dir),
          `${prefix}${entry.name}/`,
        ),
      );
    } else if (entry.isFile && entry.name.endsWith(".ts")) {
      files.push(`${prefix}${entry.name}`);
    }
  }
  return files;
}

/** Launch calls in `text` that would start Playwright's Chromium, not Chrome:
 *  any `.launch(` other than `webkit.launch(`, and any persistent context
 *  whose own options do not name the chrome channel. */
export function strayLaunches(text: string): string[] {
  const stray: string[] = [];
  for (const match of text.matchAll(/(\w*)\s*\)?\s*\.\s*launch\s*\(/g)) {
    if (match[1] !== "webkit") stray.push(match[0].trim());
  }
  for (const match of text.matchAll(/\.\s*launchPersistentContext\s*\(/g)) {
    // The call's arguments, up to its closing parenthesis.
    let depth = 0, end = match.index! + match[0].length - 1;
    for (; end < text.length; end++) {
      if (text[end] === "(") depth++;
      else if (text[end] === ")" && --depth === 0) break;
    }
    const args = text.slice(match.index!, end);
    if (!/channel:\s*["']chrome["']/.test(args)) stray.push(match[0].trim());
  }
  return stray;
}

Deno.test("the launch guard sees past spelling and per call", () => {
  assertEquals(strayLaunches("await chromium.launch()").length, 1);
  assertEquals(strayLaunches("await chromium\n  .launch({})").length, 1);
  assertEquals(
    strayLaunches("(engine === 'webkit' ? webkit : chromium).launch()").length,
    1,
  );
  assertEquals(strayLaunches("const { launch } = x; b.launch()").length, 1);
  assertEquals(strayLaunches("await webkit.launch()"), []);
  assertEquals(
    strayLaunches(
      'chromium.launchPersistentContext(p, { channel: "chrome" });\n' +
        "chromium.launchPersistentContext(q, { headless: true });",
    ).length,
    1,
  );
  assertEquals(
    strayLaunches("chromium.launchPersistentContext(p, { channel: 'chrome' })"),
    [],
  );
});

Deno.test("every Chromium-family acceptance test starts its browser through tests/browser.ts", async () => {
  // A stray launch would run Playwright's headless Chromium, not the Chrome
  // people use. The release scripts stay on the pinned build on purpose (see
  // tests/browser.ts); scripts/measure-boot.ts goes through launchOptions.
  const offenders: string[] = [];
  const root = new URL("./", import.meta.url);
  for (const file of await tsFiles(root)) {
    if (file === "browser.ts" || file === "browser_test.ts") continue;
    const stray = strayLaunches(await Deno.readTextFile(new URL(file, root)));
    if (stray.length > 0) offenders.push(`${file}: ${stray.join(", ")}`);
  }
  assertEquals(offenders, []);
});
