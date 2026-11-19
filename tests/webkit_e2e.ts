/**
 * The playground in Playwright's WebKit (JavaScriptCore, the engine whose
 * shared-memory reservations #2996 is about; not Safari itself, which only
 * safaridriver on a Mac drives). The sandbox boots, a burst of
 * `window.yurt.exec` calls all succeed, and every guest Worker took the
 * direct port to its coordinator, never the page relay: on JavaScriptCore
 * that needs both the playground's per-process reservation (#179) and a
 * kernel that honours it (yurtos-kernel#3115), so a regression in either
 * puts the guests back on the relay and turns this red
 * (src/guest_port_policy.ts). The coordinator must also have measured
 * what the tab can reserve before building its kernel (#270). On an
 * emulated iPad, the terminal's touch key bar sends Esc, Tab and Ctrl,
 * recalls history and pastes (#273); on an emulated iPhone every control in
 * the terminal's bar can be reached, and so can every touch key. Run: `deno run --allow-all tests/webkit_e2e.ts` (needs the
 * kernel checkout and pinned artifacts like playground_e2e.ts).
 */
import { devices, type Page, webkit } from "playwright";
import { showAllSections } from "./show_all_sections.ts";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureBundle } from "../scripts/serve.ts";
import { startPlaygroundServer } from "../src/serve.ts";
import { GUEST_PORT_COUNTS } from "../src/page_worker_bridge.ts";
import { touchKeysWork } from "./playground_e2e.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXECS = 40;

/** Every shown control in the terminal pane's bar lies inside the pane
 * and the viewport, without scrolling the page sideways: first as the
 * booted page shows them, then with the network on and connections open
 * (the toggle's longest label, the count and Cut connections). On an
 * iPhone the bar once ran past the pane's edge, which clips it, and the
 * buttons there could not be reached (#381's deploy). */
async function terminalBarFits(page: Page): Promise<void> {
  const measure = () =>
    page.evaluate(() => {
      const pane = document.querySelector<HTMLElement>(
        'section.pane[aria-label="terminal"]',
      )!;
      const box = pane.getBoundingClientRect();
      const controls = Array.from(
        pane.querySelectorAll<HTMLElement>(".bar > *"),
      ).filter((el) => !el.hidden && el.offsetParent !== null);
      return {
        width: innerWidth,
        pageScrolls: document.documentElement.scrollWidth > innerWidth,
        cut: controls.filter((el) => {
          const r = el.getBoundingClientRect();
          return r.left < box.left || r.right > box.right ||
            r.right > innerWidth;
        }).map((el) => el.id || el.className || el.tagName),
        shown: controls.map((el) => el.id || el.className || el.tagName),
      };
    });
  const check = async (state: string) => {
    const got = await measure();
    if (got.cut.length > 0 || got.pageScrolls) {
      throw new Error(
        `terminal bar on a phone (${state}): ${JSON.stringify(got)}`,
      );
    }
    return got;
  };
  const booted = await check("booted");
  for (const id of ["export-home", "upload-files", "network-toggle"]) {
    if (!booted.shown.includes(id)) {
      throw new Error(`terminal bar on a phone: no ${id} in ${booted.shown}`);
    }
  }
  // The widest the network's controls get, set by hand: turning the
  // network on here would ask Turnstile on a host it does not serve.
  await page.evaluate(() => {
    document.getElementById("network-toggle")!.textContent =
      "Network: on (via Yurt relay)";
    const open = document.getElementById("network-open")!;
    open.textContent = "16 open";
    open.hidden = false;
    document.getElementById("network-cut")!.hidden = false;
  });
  await check("network on");
}

/** The touch keys on a phone: one row that scrolls sideways (the keys are
 * wider than the screen), and every key, scrolled to, lies inside the
 * viewport. What they send is touchKeysWork's (playground_e2e.ts runs it on
 * an iPhone, the iPad scene above here). */
async function touchKeysReachable(page: Page): Promise<void> {
  const got = await page.getByTestId("term-keys").evaluate((bar) => {
    const keys = Array.from(bar.querySelectorAll("button"));
    const out = keys.map((key) => {
      key.scrollIntoView({ inline: "nearest", block: "nearest" });
      const r = key.getBoundingClientRect();
      return {
        key: key.dataset.testid,
        inside: r.left >= 0 && r.right <= innerWidth,
      };
    });
    return {
      unreachable: out.filter((k) => !k.inside).map((k) => k.key),
      keys: keys.length,
      pageScrolls: document.documentElement.scrollWidth > innerWidth,
    };
  });
  if (got.keys !== 8 || got.unreachable.length > 0 || got.pageScrolls) {
    throw new Error(`touch keys on a phone: ${JSON.stringify(got)}`);
  }
}

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
    const page = await showAllSections(await browser.newPage());
    page.on("pageerror", (error) => console.error("pageerror:", error));
    // The coordinator logs the per-process reservation it picked; a boot
    // whose probe failed says "(no probe)" (src/guest_memory_reservation.ts).
    const memoryPlans: string[] = [];
    page.on("console", (message) => {
      if (message.text().startsWith("[memory]")) {
        memoryPlans.push(message.text());
      }
    });
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
    const marks = await page.evaluate(
      (name) =>
        (globalThis as unknown as Record<string, unknown>)[name] ??
          { direct: 0, relay: 0 },
      GUEST_PORT_COUNTS,
    ) as { direct: number; relay: number };
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
    console.log("memory plans:", JSON.stringify(memoryPlans));
    if (
      memoryPlans.length === 0 ||
      !memoryPlans.every((plan) =>
        // Desktop WebKit has room for the quarter GiB (#270).
        plan.startsWith("[memory] 256 MiB per process") &&
        plan.includes("free to reserve")
      )
    ) {
      throw new Error(
        `the boot probe did not run: ${JSON.stringify(memoryPlans)}`,
      );
    }
    await page.close();
    // The engine an iPad runs: the tablet page (the shell only) and its
    // touch key bar.
    const ipad = await browser.newContext(devices["iPad Pro 11"]);
    const tablet = await showAllSections(await ipad.newPage());
    tablet.on("pageerror", (error) => console.error("pageerror:", error));
    await tablet.goto(`${server.url}/?start`, {
      waitUntil: "domcontentloaded",
    });
    await tablet.waitForFunction(
      () => document.querySelector("#status")?.textContent === "running",
      undefined,
      { timeout: 180_000 },
    );
    await touchKeysWork(tablet);
    await ipad.close();
    // An iPhone in portrait (393 px): every control in the terminal's bar
    // can be reached, the network's too, in its widest state.
    const iphone = await browser.newContext(devices["iPhone 15"]);
    const phone = await showAllSections(await iphone.newPage());
    phone.on("pageerror", (error) => console.error("pageerror:", error));
    await phone.goto(`${server.url}/?start`, {
      waitUntil: "domcontentloaded",
    });
    await phone.waitForFunction(
      () => document.querySelector("#status")?.textContent === "running",
      undefined,
      { timeout: 180_000 },
    );
    await terminalBarFits(phone);
    await touchKeysReachable(phone);
    await iphone.close();
    console.log("webkit e2e: ok");
  } finally {
    await browser.close();
    await server.shutdown();
  }
}
