import { assert } from "@std/assert";
import { chromium } from "playwright";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureBundle } from "../scripts/serve.ts";
import { startPlaygroundServer } from "../src/serve.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function modeFromArgs(args: string[]): string {
  const index = args.indexOf("--mode");
  const mode = index === -1 ? undefined : args[index + 1];
  if (mode !== "workerhost-repro") {
    throw new Error("usage: --mode workerhost-repro");
  }
  return mode;
}

async function waitForTerminal(
  page: import("playwright").Page,
  text: string,
) {
  await page.waitForFunction(
    (expected) =>
      document.querySelector(".xterm-rows")?.textContent?.includes(expected) ??
        false,
    text,
    { timeout: 30_000 },
  );
}

async function waitForPromptAfter(
  page: import("playwright").Page,
  marker: string,
) {
  await page.waitForFunction(
    (expected) => {
      const output = document.querySelector(".xterm-rows")?.textContent ?? "";
      const markerIndex = output.lastIndexOf(expected);
      return markerIndex >= 0 && /\$\s*$/.test(output.slice(markerIndex));
    },
    marker,
    { timeout: 30_000 },
  );
}

if (import.meta.main) {
  const mode = modeFromArgs(Deno.args);
  await ensureBundle(
    Deno.env.get("YURT_KERNEL_ROOT") ?? join(repoRoot, "../yurtos-kernel"),
    { testBundle: true },
  );
  const server = startPlaygroundServer(0);
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(`${server.url}/?mode=${mode}`, {
      waitUntil: "domcontentloaded",
    });
    await page.waitForFunction(
      () => document.querySelector("#status")?.textContent === "shell-ready",
      undefined,
      { timeout: 30_000 },
    ).catch(async () => {
      throw new Error(
        `shell did not become ready: status=${await page.locator("#status")
          .textContent()} terminal=${
          JSON.stringify(
            await page.locator(".xterm-rows").innerText().catch(() => ""),
          )
        }`,
      );
    });
    const terminal = page.locator(".xterm-helper-textarea");
    await terminal.click();
    await page.keyboard.type("sleep 3 & echo SHORT_BG_READY");
    await page.keyboard.press("Enter");
    await waitForTerminal(page, "SHORT_BG_READY");
    await waitForPromptAfter(page, "SHORT_BG_READY");

    await page.keyboard.type("sleep 10 & echo LONG_BG_READY");
    await page.keyboard.press("Enter");
    await waitForTerminal(page, "LONG_BG_READY");
    await waitForPromptAfter(page, "LONG_BG_READY");
    assert(
      (await page.locator(".xterm-rows").innerText()).includes("LONG_BG_READY"),
    );
  } finally {
    await browser.close();
    await server.shutdown();
  }
}
