// The desktop app, end to end: the launcher inside the bundle built for
// this machine (scripts/build-desktop.sh) boots the native sandbox it
// carries, serves the site, and in a real browser Jupyter runs a cell and
// reaches the internet from the guest. Run it after the build; it is the
// acceptance for the shipped artifact, not the source tree.
import { chromium } from "playwright";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EXECUTE_TIMEOUT_MS } from "../src/jupyter.ts";
import { watchCspViolations } from "./csp_watch.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
/** The binary inside the bundle built for this machine. */
const binary = join(
  repoRoot,
  "dist-desktop",
  Deno.build.target,
  Deno.build.os === "darwin"
    ? "Yurt Playground.app/Contents/MacOS/yurt-playground"
    : "yurt-playground/yurt-playground",
);

/** Start the binary with stdout piped (so it does not open a browser) and
 * read the URL it announces. */
async function startApp(): Promise<{ url: string; stop: () => void }> {
  const child = new Deno.Command(binary, { stdout: "piped", stderr: "inherit" })
    .spawn();
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const url = text.match(/^Yurt playground: (http:\/\/127\.0\.0\.1:\d+\/)$/m);
    if (url) {
      return {
        url: url[1],
        stop: () => {
          child.kill("SIGTERM");
          reader.cancel().catch(() => undefined);
        },
      };
    }
    const { value, done } = await reader.read();
    if (done) throw new Error(`${binary} exited without announcing a URL`);
    text += decoder.decode(value, { stream: true });
  }
}

if (import.meta.main) {
  const app = await startApp();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const started = Date.now();
    const csp = watchCspViolations(page);
    // The app runs the sandbox natively: the launcher says so, and the boot
    // it reports is seconds, not the tab's minutes.
    const desktop = await (await fetch(`${app.url}desktop.json`)).json();
    if (desktop.native !== true) {
      throw new Error(`desktop.json is not native: ${JSON.stringify(desktop)}`);
    }
    if (typeof desktop.bootMs !== "number" || desktop.bootMs > 60_000) {
      throw new Error(`native boot took ${desktop.bootMs} ms`);
    }
    console.log(`desktop e2e: native sandbox booted in ${desktop.bootMs} ms`);
    await page.goto(`${app.url}?start=1`, {
      waitUntil: "domcontentloaded",
    });
    await page.getByTestId("notebook-status").waitFor({
      state: "visible",
      timeout: 30_000,
    });
    // The header says where the sandbox is (yurt-playground#89).
    const lead = await page.locator("#lead").textContent();
    if (!(lead ?? "").includes("natively")) {
      throw new Error(`the native page still claims the tab: ${lead}`);
    }
    if (await page.locator("#offline-note").isVisible()) {
      throw new Error("the native page still says the sandbox has no network");
    }
    // Same budget as playground_e2e.ts: ~30 s on a laptop, several times
    // that on a small CI runner.
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
      { timeout: 300_000 },
    ).catch(() => undefined);
    if (await page.getByTestId("notebook-status").textContent() !== "ready") {
      const status = await page.locator("#status").textContent();
      throw new Error(
        `Jupyter did not become ready after ${
          Math.round((Date.now() - started) / 1000)
        } s: status=${status}`,
      );
    }
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
    await page.getByTestId("notebook-input").fill("1+1");
    await page.getByTestId("notebook-execute").click();
    await cellDone("2");
    console.log(
      `desktop e2e: first cell done after ${
        Math.round((Date.now() - started) / 1000)
      } s`,
    );
    // What the native app is for: the guest reaches the internet, over TLS.
    await page.getByTestId("notebook-input").fill(
      "import urllib.request; urllib.request.urlopen('https://example.com', timeout=30).status",
    );
    await page.getByTestId("notebook-execute").click();
    await cellDone("200");
    // A shell cell: IPython's `!` goes pexpect -> ptyprocess -> resource,
    // then posix_spawn; both work on the native runtime (#4; the in-tab
    // kernel still cannot spawn, yurtos-kernel#2771). The output is what
    // BusyBox echo wrote, streamed as stdout.
    await page.getByTestId("notebook-input").fill("!echo hi");
    await page.getByTestId("notebook-execute").click();
    await cellDone("hi\n");
    console.log("desktop e2e: !echo hi ran in BusyBox");
    // The Notebook page too: its kernel plugin lives under /jupyter/ and must
    // find the launcher's /desktop.json from there (the bundle has no in-tab
    // kernel to fall back to).
    await page.goto(
      `${app.url}jupyter/notebooks/index.html?path=welcome.ipynb`,
      {
        waitUntil: "domcontentloaded",
      },
    );
    await page.locator(".jp-Notebook").first().waitFor({ timeout: 60_000 });
    await page.waitForFunction(
      () =>
        document.querySelector(".jp-Toolbar-kernelName")?.textContent
            ?.includes("Yurt") === true &&
        document.querySelector(".jp-Notebook-ExecutionIndicator")
            ?.getAttribute("data-status") === "idle",
      undefined,
      { timeout: 120_000 },
    );
    console.log(
      `desktop e2e: notebook kernel idle after ${
        Math.round((Date.now() - started) / 1000)
      } s`,
    );
    csp();
    console.log(
      `desktop e2e: Jupyter cells ran after ${
        Math.round((Date.now() - started) / 1000)
      } s`,
    );
  } finally {
    await browser.close();
    app.stop();
  }
}
