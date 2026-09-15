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
    await page.goto(`${app.url}terminal.html`, {
      waitUntil: "domcontentloaded",
    });
    await page.getByTestId("notebook-status").waitFor({
      state: "visible",
      timeout: 30_000,
    });
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
