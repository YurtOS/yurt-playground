/**
 * Browser acceptance for Playwright in the in-tab sandbox: the page with
 * `?env=playwright`, in Chrome with the Yurt browser bridge extension
 * (extension/), installs node and playwright-core in the sandbox; then
 * `node playwright-example.js <url>` there opens a tab in this browser
 * through the guest's DevTools endpoint (src/cdp_bridge.ts), the page and
 * the extension, reads its title and screenshots it.
 *
 * Run: deno run --allow-all tests/browser_bridge_e2e.ts (after
 * scripts/install-pinned-artifacts.sh, like the other scenes).
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launchWithExtension } from "../scripts/browser.ts";
import { ensureBundle } from "../scripts/serve.ts";
import { startPlaygroundServer } from "../src/serve.ts";
import { READY_NOTE } from "../src/playwright_demo.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function fail(message: string): never {
  throw new Error(message);
}

if (import.meta.main) {
  await ensureBundle(
    Deno.env.get("YURT_KERNEL_ROOT") ?? join(repoRoot, "../yurtos-kernel"),
  );
  const server = startPlaygroundServer(0);
  const context = await launchWithExtension(join(repoRoot, "extension"));
  try {
    const page = await context.newPage();
    await page.goto(`${server.url}/?start&platform=desktop&env=playwright`, {
      waitUntil: "domcontentloaded",
    });
    await page.waitForFunction(
      (ready) =>
        (document.getElementById("platform-note-text")?.textContent ?? "")
          .includes(ready) ||
        /Playwright setup failed|not installed/.test(
          document.getElementById("platform-note-text")?.textContent ?? "",
        ),
      READY_NOTE,
      { timeout: 600_000 },
    );
    const note = await page.textContent("#platform-note-text");
    if (!note?.includes(READY_NOTE)) fail(`setup did not finish: ${note}`);
    console.log("browser bridge e2e: Playwright set up in the sandbox");

    const target = `${server.url}/unsupported.html`;
    const result = await page.evaluate(async (url) => {
      const yurt = (globalThis as unknown as {
        yurt: {
          exec(cmd: string): Promise<
            { code: number | null; stdout: string; stderr: string }
          >;
        };
      }).yurt;
      return await yurt.exec(`node playwright-example.js ${url}`);
    }, target);
    console.log(`browser bridge e2e: ${result.stdout.trim()}`);
    if (result.code !== 0) fail(`the example failed: ${result.stderr}`);
    if (!result.stdout.includes("title: Yurt playground: this page cannot")) {
      fail(`the example read the wrong page: ${result.stdout}`);
    }
    // The tab it opened is this browser's: the extension made it.
    const urls = context.pages().map((p) => p.url());
    if (!urls.includes(target)) fail(`no tab on ${target}: ${urls}`);
    const shot = await page.evaluate(async () =>
      (await (globalThis as unknown as {
        yurt: { fs: { read(path: string): Promise<Uint8Array> } };
      }).yurt.fs.read("/home/user/playwright-example.png")).length
    );
    if (shot < 1000) fail(`the screenshot is ${shot} bytes`);
    console.log(
      `browser bridge e2e: a tab on ${target}, screenshot ${shot} bytes; passed`,
    );
  } finally {
    await context.close();
    await server.shutdown();
  }
}
