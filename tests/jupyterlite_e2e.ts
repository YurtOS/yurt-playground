/**
 * Browser acceptance for the Jupyter Notebook interface: the JupyterLite
 * frontend at /jupyter/ drives the real ipykernel inside the sandbox through
 * the Yurt kernel plugin. Also checks the home page's routing (a phone lands
 * on the unsupported page; a desktop gets the choices).
 *
 * Run: deno run --allow-all tests/jupyterlite_e2e.ts (needs the pinned blobs
 * in artifacts/ and the site from jupyterlite/build.sh in public/jupyter/).
 */
import { chromium, devices } from "playwright";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureBundle } from "../scripts/serve.ts";
import { startPlaygroundServer } from "../src/serve.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function fail(message: string): never {
  throw new Error(message);
}

if (import.meta.main) {
  await ensureBundle(
    Deno.env.get("YURT_KERNEL_ROOT") ?? join(repoRoot, "../yurtos-kernel"),
  );
  await Deno.stat(join(repoRoot, "public/jupyter/index.html")).catch(() =>
    fail("public/jupyter is missing; run jupyterlite/build.sh first")
  );
  const server = startPlaygroundServer(0);
  const browser = await chromium.launch();
  try {
    // A phone is sent to the unsupported page from the home page.
    const phone = await browser.newContext({ ...devices["iPhone 13"] });
    const phonePage = await phone.newPage();
    await phonePage.goto(`${server.url}/`, { waitUntil: "load" });
    await phonePage.getByTestId("unsupported").waitFor({ timeout: 10_000 });
    // "Try anyway" gets the same phone to the home page, and the choice
    // sticks for the terminal page too.
    await phonePage.getByTestId("try-anyway").click();
    await phonePage.getByTestId("choose-notebook").waitFor({ timeout: 10_000 });
    await phonePage.goto(`${server.url}/terminal.html`, { waitUntil: "load" });
    await phonePage.locator("#term").waitFor({ timeout: 10_000 });
    await phone.close();

    const page = await browser.newPage();
    await page.goto(`${server.url}/`, { waitUntil: "domcontentloaded" });
    if (await page.evaluate(() => globalThis.crossOriginIsolated !== true)) {
      fail("browser page is not cross-origin isolated");
    }
    await page.getByTestId("choose-notebook").click();
    await page.waitForURL(/\/jupyter\/notebooks\/index\.html/);
    await page.locator(".jp-Notebook").first().waitFor({ timeout: 60_000 });
    // The kernel plugin boots the sandbox and connects the guest ipykernel.
    // Before the session starts the toolbar reads "No Kernel" with an idle
    // indicator, so both the name and the status are required.
    await page.waitForFunction(
      () =>
        document.querySelector(".jp-Toolbar-kernelName")?.textContent
            ?.includes("Yurt") === true &&
        document.querySelector(".jp-Notebook-ExecutionIndicator")
            ?.getAttribute("data-status") === "idle",
      undefined,
      // Measured 2026-09-14: ~50 s on an M-series laptop.
      { timeout: 240_000 },
    );

    // Run the welcome notebook's two code cells with Shift+Enter.
    await page.locator(".jp-Cell").first().click();
    for (let i = 0; i < 3; i++) {
      await page.keyboard.press("Shift+Enter");
      await page.waitForTimeout(300);
    }
    await page.waitForFunction(
      () => {
        const outputs = [...document.querySelectorAll(".jp-OutputArea-output")]
          .map((node) => node.textContent ?? "");
        const prompts = [...document.querySelectorAll(".jp-InputPrompt")]
          .map((node) => node.textContent ?? "");
        return outputs.length >= 2 &&
          outputs[0].includes("3.14.") &&
          outputs[1].includes("12.") &&
          prompts.every((prompt) => !prompt.includes("*"));
      },
      undefined,
      { timeout: 180_000 },
    );
    console.log("jupyterlite e2e: notebook executed on the guest ipykernel");
  } finally {
    await browser.close();
    await server.shutdown();
  }
}
