import { chromium } from "playwright";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureBundle } from "../scripts/serve.ts";
import { startPlaygroundServer } from "../src/serve.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

if (import.meta.main) {
  await ensureBundle(
    Deno.env.get("YURT_KERNEL_ROOT") ?? join(repoRoot, "../yurtos-kernel"),
  );
  const server = startPlaygroundServer(0);
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(server.url, { waitUntil: "domcontentloaded" });
    if (await page.evaluate(() => globalThis.crossOriginIsolated !== true)) {
      throw new Error("browser page is not cross-origin isolated");
    }
    await page.getByTestId("notebook-status").waitFor({
      state: "visible",
      timeout: 240_000,
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
      { timeout: 240_000 },
    ).catch(() => undefined);
    if (await page.getByTestId("notebook-status").textContent() !== "ready") {
      const status = await page.locator("#status").textContent();
      const notebook = await page.getByTestId("notebook-status").textContent();
      const terminal = await page.locator(".xterm-rows").innerText().catch(() =>
        ""
      );
      throw new Error(
        `Jupyter did not become ready: status=${status} notebook=${notebook} terminal=${
          JSON.stringify(terminal)
        }`,
      );
    }
    await page.getByTestId("notebook-input").fill("1+1");
    await page.getByTestId("notebook-execute").click();
    await page.getByTestId("notebook-output").waitFor({ state: "visible" });
    await page.waitForFunction(() =>
      document.querySelector<HTMLElement>("[data-testid=notebook-output]")
        ?.textContent === "2"
    );
    await page.getByTestId("notebook-input").fill(
      "import numpy as np; np.array([1, 2]).sum()",
    );
    await page.getByTestId("notebook-execute").click();
    await page.waitForFunction(() =>
      document.querySelector<HTMLElement>("[data-testid=notebook-output]")
        ?.textContent === "3"
    );
    if (!(await page.locator("#term").isVisible())) {
      throw new Error("ash terminal is not visible");
    }
  } finally {
    await browser.close();
    await server.shutdown();
  }
}
