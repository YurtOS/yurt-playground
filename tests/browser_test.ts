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

/** The values (not types) `text` imports from "playwright", and whether it
 *  imports the module whole (`import * as`, a default or `import()`). */
function playwrightImports(text: string): { names: string[]; whole: boolean } {
  const names: string[] = [];
  let whole = /import\s*\(\s*["']playwright["']\s*\)/.test(text);
  for (
    const match of text.matchAll(
      /import\s+(type\s+)?([^;]*?)\s+from\s+["']playwright["']/g,
    )
  ) {
    if (match[1]) continue;
    const clause = match[2];
    const braces = clause.match(/\{([^}]*)\}/);
    if (braces === null || clause.replace(braces[0], "").match(/\w/)) {
      whole = true;
    }
    for (const part of braces?.[1].split(",") ?? []) {
      const name = part.trim();
      if (name !== "" && !name.startsWith("type ")) {
        names.push(name.split(/\s+as\s+/)[0]);
      }
    }
  }
  return { names, whole };
}

/** Files that may start Chrome themselves: persistent contexts on the
 *  chrome channel (a GPU and a kept profile), run on a Mac by hand. */
const OWN_CHROME = ["agent_demo_e2e.ts", "agent_webgpu_e2e.ts"];

Deno.test("the import rule reads value and type imports apart", () => {
  assertEquals(
    playwrightImports('import { type Page, devices } from "playwright";'),
    { names: ["devices"], whole: false },
  );
  assertEquals(
    playwrightImports('import type { Browser } from "playwright";'),
    {
      names: [],
      whole: false,
    },
  );
  assertEquals(
    playwrightImports('import { chromium as c } from "playwright";').names,
    ["chromium"],
  );
  assertEquals(
    playwrightImports('import * as pw from "playwright";').whole,
    true,
  );
  assertEquals(
    playwrightImports('const pw = await import("playwright");').whole,
    true,
  );
});

Deno.test("every Chromium-family acceptance test starts its browser through scripts/browser.ts", async () => {
  // Under tests/, Playwright gives types, devices and WebKit only: a scene
  // that could reach `chromium` could start Playwright's headless build.
  const offenders: string[] = [];
  const root = new URL("./", import.meta.url);
  for (const file of await tsFiles(root)) {
    if (file === "browser_test.ts") continue;
    const text = await Deno.readTextFile(new URL(file, root));
    const { names, whole } = playwrightImports(text);
    const extra = names.filter((n) => n !== "devices" && n !== "webkit");
    if (OWN_CHROME.includes(file)) {
      if (!/channel:\s*"chrome"/.test(text)) {
        offenders.push(`${file}: no chrome channel`);
      }
      continue;
    }
    if (whole || extra.length > 0) {
      offenders.push(`${file}: ${whole ? "whole module" : extra.join(", ")}`);
    }
  }
  assertEquals(offenders, []);
});
