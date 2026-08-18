import { resolvePlaygroundArtifacts } from "./ash_harness.ts";
import { startPlaygroundServer } from "../src/serve.ts";

function termHas(
  page: {
    waitForFunction(
      fn: (needle: string) => boolean,
      arg: string,
      opts: { timeout: number },
    ): Promise<unknown>;
  },
  needle: string,
  timeout = 10_000,
): Promise<unknown> {
  return page.waitForFunction(
    (want) => {
      const text = [...document.querySelectorAll(".xterm-rows > div")]
        .map((row) => (row.textContent ?? "").replace(/\u00a0/g, " ").trimEnd())
        .join("\n");
      return text.includes(want);
    },
    needle,
    { timeout },
  );
}

Deno.test({
  name: "Chromium ash: echo hi, uname, and ls",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    if (!await resolvePlaygroundArtifacts()) return;
    let chromium;
    try {
      ({ chromium } = await import("playwright"));
    } catch (error) {
      console.log(
        `skipping Chromium ash: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return;
    }
    let browser;
    try {
      browser = await chromium.launch({ channel: "chrome", headless: true });
    } catch (error) {
      console.log(
        `skipping Chromium ash: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return;
    }
    const { url, shutdown } = startPlaygroundServer(0);
    const page = await browser.newPage();
    try {
      await page.goto(url, { waitUntil: "domcontentloaded" });
      const isolated = await page.evaluate(() =>
        globalThis.crossOriginIsolated
      );
      if (isolated !== true) {
        throw new Error("page is not crossOriginIsolated");
      }
      await page.waitForFunction(
        () => (document.getElementById("status")?.textContent ?? "") === "",
        { timeout: 90_000 },
      );
      await termHas(page, "$", 15_000);
      await page.locator(".xterm").click();
      await page.keyboard.type("echo hi");
      await page.keyboard.press("Enter");
      await termHas(page, "hi");
      await page.keyboard.type("uname");
      await page.keyboard.press("Enter");
      await termHas(page, "Linux");
      await page.keyboard.type("ls");
      await page.keyboard.press("Enter");
      await termHas(page, "ls");
    } finally {
      await page.close();
      await browser.close();
      await shutdown();
    }
  },
});
