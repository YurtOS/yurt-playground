import { assertEquals, assertThrows } from "@std/assert";
import { launchOptions, parseBrowser } from "../scripts/browser.ts";

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

/** Files that may start Chrome themselves: persistent contexts on the
 *  chrome channel (a GPU and a kept profile), run on a Mac by hand. */
const OWN_CHROME = ["agent_demo_e2e.ts", "agent_webgpu_e2e.ts"];

Deno.test("every Chromium-family acceptance test starts its browser through scripts/browser.ts", async () => {
  // Under tests/, nothing names Playwright's `chromium` (however imported,
  // and in a comment too): a scene that could reach it could start the
  // headless build. Fails closed; the two listed scenes name the chrome
  // channel on every launch.
  const offenders: string[] = [];
  const root = new URL("./", import.meta.url);
  for (const file of await tsFiles(root)) {
    if (file === "browser_test.ts" || file === "layout_test.ts") continue;
    const text = await Deno.readTextFile(new URL(file, root));
    if (OWN_CHROME.includes(file)) {
      // Each launch's own options (the text up to the next launch) name it.
      const starts = [...text.matchAll(/\bchromium\s*\.\s*launch\w*\s*\(/g)]
        .map((m) => m.index!);
      starts.forEach((start, i) => {
        const call = text.slice(start, starts[i + 1] ?? start + 600);
        if (!/channel:\s*"chrome"/.test(call.slice(0, 600))) {
          offenders.push(`${file}: a launch without the chrome channel`);
        }
      });
      continue;
    }
    if (/\bchromium\b/.test(text)) offenders.push(file);
  }
  assertEquals(offenders, []);
});
