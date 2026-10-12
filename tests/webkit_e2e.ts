/**
 * The playground in Playwright's WebKit (JavaScriptCore, the engine whose
 * shared-memory reservations #2996 is about; not Safari itself, which only
 * safaridriver on a Mac drives). The sandbox boots, a burst of
 * `window.yurt.exec` calls all succeed, and every guest Worker took the
 * direct port to its coordinator, never the page relay: on JavaScriptCore
 * that needs both the playground's per-process reservation (#179) and a
 * kernel that honours it (yurtos-kernel#3115), so a regression in either
 * puts the guests back on the relay and turns this red
 * (src/guest_port_policy.ts). Run: `deno run --allow-all
 * tests/webkit_e2e.ts` (needs the kernel checkout and pinned artifacts like
 * playground_e2e.ts).
 */
import { webkit } from "playwright";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureBundle } from "../scripts/serve.ts";
import { startPlaygroundServer } from "../src/serve.ts";
import {
  GUEST_PORT_DIRECT_MARK,
  GUEST_PORT_RELAY_MARK,
} from "../src/page_worker_bridge.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXECS = 40;

/** The slice of `window.yurt` (src/agent_api.ts) this scene drives. */
type PageYurt = {
  ready: Promise<unknown>;
  exec(
    command: string,
  ): Promise<{ code: number | null; stdout: string; stderr: string }>;
};

if (import.meta.main) {
  await ensureBundle(
    Deno.env.get("YURT_KERNEL_ROOT") ?? join(repoRoot, "../yurtos-kernel"),
  );
  const server = startPlaygroundServer(0);
  const browser = await webkit.launch();
  try {
    const page = await browser.newPage();
    page.on("pageerror", (error) => console.error("pageerror:", error));
    await page.goto(`${server.url}/?start`, { waitUntil: "domcontentloaded" });
    const engine = await page.evaluate(() => ({
      userAgent: navigator.userAgent,
      isolated: globalThis.crossOriginIsolated,
    }));
    console.log("engine:", JSON.stringify(engine));
    if (!engine.isolated) {
      throw new Error("WebKit page is not cross-origin isolated");
    }
    await page.waitForFunction(
      () => (globalThis as { yurt?: unknown }).yurt !== undefined,
      null,
      {
        timeout: 120_000,
      },
    );
    const ready = await page.evaluate(() =>
      (globalThis as unknown as { yurt: PageYurt }).yurt.ready.then(
        () => "ready",
        (error: unknown) => `rejected: ${error}`,
      )
    );
    if (ready !== "ready") {
      throw new Error(
        `sandbox did not boot (${ready}); status: ${await page.locator(
          "#status",
        ).textContent()}`,
      );
    }
    const result = await page.evaluate(async (count) => {
      const failures: string[] = [];
      let ok = 0;
      for (let i = 0; i < count; i++) {
        try {
          const run = await (globalThis as unknown as { yurt: PageYurt }).yurt
            .exec(`echo webkit-${i}`);
          if (run.code === 0 && run.stdout === `webkit-${i}\n`) ok++;
          else failures.push(`#${i}: code ${run.code} ${run.stderr}`);
        } catch (error) {
          failures.push(`#${i}: ${error}`);
        }
      }
      return { ok, failures: failures.slice(0, 3) };
    }, EXECS);
    const marks = await page.evaluate(([direct, relay]) => ({
      direct: performance.getEntriesByName(direct).length,
      relay: performance.getEntriesByName(relay).length,
    }), [GUEST_PORT_DIRECT_MARK, GUEST_PORT_RELAY_MARK]);
    console.log(
      "execs:",
      JSON.stringify(result),
      "guest ports:",
      JSON.stringify(marks),
    );
    if (result.ok !== EXECS) {
      throw new Error(
        `${result.ok}/${EXECS} execs succeeded: ${result.failures}`,
      );
    }
    if (marks.relay !== 0 || marks.direct < EXECS) {
      throw new Error(
        `expected every guest on the direct port, got ${JSON.stringify(marks)}`,
      );
    }
    console.log("webkit e2e: ok");
  } finally {
    await browser.close();
    await server.shutdown();
  }
}
