import { chromium, devices, type Page } from "playwright";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureBundle } from "../scripts/serve.ts";
import { startPlaygroundServer } from "../src/serve.ts";
import { EXECUTE_TIMEOUT_MS } from "../src/jupyter.ts";
import { watchCspViolations } from "./csp_watch.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** "Run it on your machine" is a radio group behind four labels: Tab lands
 * on the chosen one, the arrow keys move the choice and the panel with it,
 * and the ring shows on the label of the focused radio. */
async function installChoicesWorkByKeyboard(page: Page): Promise<void> {
  const shown = () =>
    page.evaluate(() => {
      const panel = [
        ...document.querySelectorAll<HTMLElement>("#install .panel"),
      ]
        .find((p) => getComputedStyle(p).display !== "none");
      const focused = document.activeElement as HTMLInputElement | null;
      const label = focused?.id
        ? document.querySelector<HTMLElement>(`label[for="${focused.id}"]`)
        : null;
      return {
        panel: panel?.className.replace("panel ", ""),
        focused: focused?.id,
        ringed: label ? getComputedStyle(label).outlineStyle !== "none" : false,
      };
    });
  await page.locator("#install-app-mac").focus();
  // A pointer focus draws no ring; the keyboard's does.
  await page.keyboard.press("ArrowDown");
  const order = ["app-linux", "cli-mac", "cli-linux", "app-mac"];
  for (const expected of order) {
    const state = await shown();
    if (
      state.panel !== expected || state.focused !== `install-${expected}` ||
      !state.ringed
    ) {
      throw new Error(
        `install choice by keyboard: want ${expected} focused, shown and ringed, got ${
          JSON.stringify(state)
        }`,
      );
    }
    await page.keyboard.press("ArrowDown");
  }
}

/** A boot that dies before the shell shows anything explains itself in the
 * terminal's place: the browser's message, and on a phone the likely cause.
 * The status bar stays terse; the reason is in the pane. */
async function bootFailureIsExplained(
  browser: Awaited<ReturnType<typeof chromium.launch>>,
  url: string,
): Promise<void> {
  for (const phone of [true, false]) {
    const context = await browser.newContext(
      phone ? devices["iPhone 13"] : {},
    );
    const page = await context.newPage();
    await page.route(
      "**/yurt_kernel.wasm",
      (route) => route.fulfill({ status: 503 }),
    );
    await page.goto(`${url}/?start`, { waitUntil: "domcontentloaded" });
    await page.getByTestId("boot-failed").waitFor({
      state: "visible",
      timeout: 30_000,
    });
    const state = {
      status: await page.locator("#status").textContent(),
      reason: await page.locator("#failed-reason").textContent(),
      device: await page.locator("#failed-device").isVisible(),
    };
    await context.close();
    if (
      state.status !== "failed" ||
      state.reason !== "fetch ./yurt_kernel.wasm failed: 503" ||
      state.device !== phone
    ) {
      throw new Error(
        `boot failure on ${phone ? "a phone" : "desktop"}: ${
          JSON.stringify(state)
        }`,
      );
    }
  }
}

if (import.meta.main) {
  await ensureBundle(
    Deno.env.get("YURT_KERNEL_ROOT") ?? join(repoRoot, "../yurtos-kernel"),
  );
  const server = startPlaygroundServer(0);
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const started = Date.now();
    const csp = watchCspViolations(page);
    // The primary flow: the home page, and the one action on it.
    await page.goto(`${server.url}/`, { waitUntil: "domcontentloaded" });
    if (await page.evaluate(() => globalThis.crossOriginIsolated !== true)) {
      throw new Error("browser page is not cross-origin isolated");
    }
    await installChoicesWorkByKeyboard(page);
    await page.getByTestId("start-sandbox").click();
    // The button yields to the boot; the cell is part of the workspace.
    await page.getByTestId("start-sandbox").waitFor({ state: "hidden" });
    await page.getByTestId("notebook-status").waitFor({
      state: "visible",
      timeout: 30_000,
    });
    await page.waitForFunction(
      () => {
        const notebook = document.querySelector<HTMLElement>(
          "[data-testid=notebook-status]",
        );
        const status = document.querySelector<HTMLElement>("#status");
        return notebook?.textContent === "ready" ||
          (status?.textContent ?? "").includes("failed");
      },
      undefined,
      // Measured 2026-09-14: ~30 s from page load to ready on an M-series
      // laptop (cold import of ipykernel + pyzmq in the browser JIT); a
      // 2-vCPU CI runner needs several times that.
      { timeout: 300_000 },
    ).catch(() => undefined);
    if (await page.getByTestId("notebook-status").textContent() !== "ready") {
      const status = await page.locator("#status").textContent();
      const notebook = await page.getByTestId("notebook-status").textContent();
      throw new Error(
        `Jupyter did not become ready after ${
          Math.round((Date.now() - started) / 1000)
        } s: status=${status} notebook=${notebook}`,
      );
    }
    console.log(
      `playground e2e: Jupyter ready after ${
        Math.round((Date.now() - started) / 1000)
      } s`,
    );
    await page.getByTestId("notebook-input").fill("1+1");
    await page.getByTestId("notebook-execute").click();
    await page.getByTestId("notebook-output").waitFor({ state: "visible" });
    // A cell error lands in the same element, so a wrong answer fails fast
    // instead of waiting out the timeout.
    const cellDone = (expected: string) =>
      page.waitForFunction(
        (want) => {
          const text = document.querySelector<HTMLElement>(
            "[data-testid=notebook-output]",
          )?.textContent ?? "";
          if (text === want) return true;
          if (/timed out|Error|Traceback/.test(text)) {
            throw new Error(`cell failed: ${text}`);
          }
          return false;
        },
        expected,
        { timeout: EXECUTE_TIMEOUT_MS + 10_000 },
      );
    await cellDone("2");
    console.log(
      `playground e2e: first cell done after ${
        Math.round((Date.now() - started) / 1000)
      } s`,
    );
    // The proof the home page advertises: with the network gone, the next
    // cell still runs, and the page says so.
    await page.context().setOffline(true);
    await page.waitForFunction(() =>
      document.querySelector("[data-testid=net]")?.getAttribute(
        "data-online",
      ) === "false"
    );
    // `int(...)`: numpy 2 displays its scalars as `np.int32(3)`.
    await page.getByTestId("notebook-input").fill(
      "import numpy as np; int(np.array([1, 2]).sum())",
    );
    await page.getByTestId("notebook-execute").click();
    await cellDone("3");
    await page.context().setOffline(false);
    await page.waitForFunction(() =>
      document.querySelector("[data-testid=net]")?.getAttribute(
        "data-online",
      ) === "true"
    );
    // Not here: `!echo hi`. IPython's `!` needs the `resource` module
    // (yurt-ports#77) and Python cannot fork or posix_spawn on the JS host
    // (yurtos-kernel#2771); it stays the open item of #4.
    // The cell and the ash terminal share one VFS: a file written by Python
    // is read back by the shell in the xterm (#4).
    await page.getByTestId("notebook-input").fill(
      "open('/tmp/from-cell', 'w').write('cell wrote this')",
    );
    await page.getByTestId("notebook-execute").click();
    await page.waitForFunction(() =>
      document.querySelector<HTMLElement>("[data-testid=notebook-output]")
        ?.textContent?.trim() === "15"
    );
    if (!(await page.locator("#term").isVisible())) {
      throw new Error("ash terminal is not visible");
    }
    await page.locator("#term").click();
    await page.keyboard.type("cat /tmp/from-cell; echo __VFS_DONE__\n");
    await page.waitForFunction(
      () => {
        const rows = document.querySelector("#term .xterm-rows")?.textContent ??
          "";
        return rows.includes("cell wrote this") &&
          rows.includes("__VFS_DONE__");
      },
      undefined,
      { timeout: 60_000 },
    );
    csp();
    await bootFailureIsExplained(browser, server.url);
  } finally {
    await browser.close();
    await server.shutdown();
  }
}
