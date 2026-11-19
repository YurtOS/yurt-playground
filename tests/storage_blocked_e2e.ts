/**
 * The playground boots for a visitor whose browser keeps no site data
 * (yurt-playground#393): a fresh Chrome profile that blocks cookies, and
 * with them the Cache API, IndexedDB, localStorage and sessionStorage,
 * opens `?start` and gets a shell that runs a command. Such a browser
 * throws on `sessionStorage` itself and refuses `caches.open`; a boot that
 * reads either unguarded never starts the sandbox.
 *
 * Run: `deno run --allow-all tests/storage_blocked_e2e.ts`; needs the
 * kernel checkout and the pinned artifacts, like playground_e2e.ts.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launchWithStorageBlocked } from "../scripts/browser.ts";
import { ensureBundle } from "../scripts/serve.ts";
import { startPlaygroundServer } from "../src/serve.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const BOOT_MS = 180_000;

if (import.meta.main) {
  await ensureBundle(
    Deno.env.get("YURT_KERNEL_ROOT") ?? join(repoRoot, "../yurtos-kernel"),
  );
  const server = startPlaygroundServer(0);
  const context = await launchWithStorageBlocked();
  try {
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    const started = Date.now();
    await page.goto(`${server.url}/?start`, { waitUntil: "domcontentloaded" });
    const marker = `__BLOCKED_${crypto.randomUUID().slice(0, 8)}__`;
    try {
      // The shell is up once it prompts; then it must run a command.
      await page.waitForFunction(
        () =>
          [...document.querySelectorAll("#term .xterm-rows > div")]
            .some((row) => /\$\s*$/.test(row.textContent ?? "")),
        undefined,
        { timeout: BOOT_MS },
      );
      await page.locator("#term").click();
      await page.keyboard.type(
        `echo ${marker.slice(0, 9)}""${marker.slice(9)}\n`,
      );
      await page.waitForFunction(
        (marker) =>
          [...document.querySelectorAll("#term .xterm-rows > div")]
            .some((row) => (row.textContent ?? "").trim() === marker),
        marker,
        { timeout: 60_000 },
      );
    } catch (error) {
      const status = await page.locator("#status").textContent();
      throw new Error(
        `no shell with site data blocked (status ${
          JSON.stringify(status)
        }; page errors ${JSON.stringify(errors)}): ${error}`,
      );
    }
    console.log(
      `storage blocked: a shell ran a command ${
        Date.now() - started
      } ms after the page opened`,
    );
  } finally {
    await context.close();
    await server.shutdown();
  }
}
