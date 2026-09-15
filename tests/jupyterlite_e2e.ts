/**
 * Browser acceptance for the Jupyter Notebook interface: the JupyterLite
 * frontend at /jupyter/ drives the real ipykernel inside the sandbox through
 * the Yurt kernel plugin. Also checks the home page's gating: a phone gets
 * the choices plus a note, and a page served without COOP/COEP lands on the
 * unsupported page.
 *
 * Run: deno run --allow-all tests/jupyterlite_e2e.ts (needs the pinned blobs
 * in artifacts/ and the site from jupyterlite/build.sh in public/jupyter/).
 */
import { chromium, devices, type Page } from "playwright";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureBundle } from "../scripts/serve.ts";
import { startPlaygroundServer } from "../src/serve.ts";
import { watchCspViolations } from "./csp_watch.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function fail(message: string): never {
  throw new Error(message);
}

/** Insert a cell below the active one, type `code` into it, and run it. */
async function runNewCell(page: Page, code: string): Promise<void> {
  await page.keyboard.press("Escape");
  await page.keyboard.press("b");
  await page.keyboard.press("Enter");
  await page.keyboard.type(code);
  await page.keyboard.press("Shift+Enter");
}

/** Wait until the notebook's last output area contains `text` and no cell
 * is still running. */
async function waitForLastOutput(
  page: Page,
  text: string,
  timeout: number,
): Promise<void> {
  await page.waitForFunction(
    (want) => {
      const outputs = [...document.querySelectorAll(".jp-OutputArea-output")];
      const last = outputs.at(-1)?.textContent ?? "";
      const prompts = [...document.querySelectorAll(".jp-InputPrompt")]
        .map((node) => node.textContent ?? "");
      return last.includes(want) &&
        prompts.every((prompt) => !prompt.includes("*"));
    },
    text,
    { timeout },
  );
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
    // A phone is not blocked: it reaches the home page and gets a note.
    const phone = await browser.newContext({ ...devices["iPhone 13"] });
    const phonePage = await phone.newPage();
    const phoneCsp = watchCspViolations(phonePage);
    await phonePage.goto(`${server.url}/`, { waitUntil: "load" });
    await phonePage.getByTestId("choose-notebook").waitFor({ timeout: 10_000 });
    await phonePage.getByTestId("mobile-note").waitFor({ timeout: 10_000 });
    phoneCsp();
    await phone.close();

    // A page served without COOP/COEP is the one thing that cannot work: the
    // home and terminal pages both send it to the explanation.
    const plain = await browser.newContext();
    await plain.route("**/*", async (route) => {
      const response = await route.fetch();
      const headers = { ...response.headers() };
      delete headers["cross-origin-opener-policy"];
      delete headers["cross-origin-embedder-policy"];
      await route.fulfill({ response, headers });
    });
    for (const path of ["/", "/terminal.html"]) {
      const plainPage = await plain.newPage();
      await plainPage.goto(`${server.url}${path}`, { waitUntil: "load" });
      await plainPage.getByTestId("unsupported").waitFor({ timeout: 10_000 });
      await plainPage.close();
    }
    await plain.close();

    const page = await browser.newPage();
    const started = Date.now();
    const csp = watchCspViolations(page);
    await page.goto(`${server.url}/`, { waitUntil: "domcontentloaded" });
    if (await page.evaluate(() => globalThis.crossOriginIsolated !== true)) {
      fail("browser page is not cross-origin isolated");
    }
    // "Check the bytes": the page re-hashes what it downloaded and every
    // file matches integrity.json, the 87 MB image included. The proof is a
    // disclosure below the workspace; open it first.
    await page.getByTestId("proof-toggle").click();
    await page.getByTestId("verify-files").click();
    await page.waitForFunction(
      () =>
        document.querySelector("[data-testid=verify-summary]")?.textContent
          ?.endsWith("files match.") === true,
      undefined,
      { timeout: 60_000 },
    );
    const summary = await page.getByTestId("verify-summary").textContent();
    if (summary !== "6 of 6 files match.") {
      fail(`verification did not pass: ${summary}`);
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
      // Measured 2026-09-14: ~50 s on an M-series laptop; a 2-vCPU CI
      // runner needs several times that.
      { timeout: 420_000 },
    );
    console.log(
      `jupyterlite e2e: kernel idle after ${
        Math.round((Date.now() - started) / 1000)
      } s`,
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
    csp();
    console.log("jupyterlite e2e: notebook executed on the guest ipykernel");

    // Interrupt reaches the guest: a busy loop ends with KeyboardInterrupt
    // once the toolbar's stop button is pressed (#31).
    await runNewCell(page, "while True: pass");
    await page.waitForFunction(() =>
      [...document.querySelectorAll(".jp-InputPrompt")].some((node) =>
        node.textContent?.includes("*")
      )
    );
    await page.waitForTimeout(1_000);
    await page.locator('[data-jp-item-name="interrupt"] button').click();
    await waitForLastOutput(page, "KeyboardInterrupt", 60_000);
    console.log("jupyterlite e2e: interrupt stopped a busy loop");

    // Restart reaches the guest: a variable defined before the restart is
    // gone after it, because the ipykernel process was replaced (#31).
    await runNewCell(page, "x = 1");
    await runNewCell(page, "x");
    await waitForLastOutput(page, "1", 60_000);
    await page.locator('[data-jp-item-name="restart"] button').click();
    await page.locator(".jp-Dialog button.jp-mod-accept").click();
    await page.waitForFunction(
      () =>
        document.querySelector(".jp-Toolbar-kernelName")?.textContent
            ?.includes("Yurt") === true &&
        document.querySelector(".jp-Notebook-ExecutionIndicator")
            ?.getAttribute("data-status") === "idle",
      undefined,
      { timeout: 420_000 },
    );
    await runNewCell(page, "x");
    await waitForLastOutput(page, "NameError", 120_000);
    console.log("jupyterlite e2e: restart replaced the guest kernel");
  } finally {
    await browser.close();
    await server.shutdown();
  }
}
