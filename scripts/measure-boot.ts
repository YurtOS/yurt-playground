#!/usr/bin/env -S deno run --allow-all
/**
 * measure-boot.ts -- how fast the page gets to a usable shell, and how
 * much memory it takes, in a device's emulation: the numbers behind the
 * README's "Snapshots in use" (its RAM column is this script's peak).
 *
 * It serves this checkout (the dev server), opens the page in a fresh
 * browser profile (cold: nothing cached), waits for the shell to answer a
 * typed line, then loads the page again in the same profile (warm: the
 * snapshot's parts in the Cache API). For each load it prints one JSON
 * line: seconds to a usable prompt, the console's snapshot line (download,
 * inflate and restore times), whether it fell back to booting the image,
 * and in Chromium the renderer processes' peak resident memory.
 *
 * Usage: deno run -A scripts/measure-boot.ts [--device phone|tablet|desktop]
 *          [--engine chromium|webkit] [--query 'start&start-anyway']
 *          [--pins PATH] [--warm N]
 *
 *   --device  the emulation: iPhone 13, iPad Pro 11, or a desktop
 *   --query   the page's query (default `start&start-anyway`: Start pressed
 *             at load; add `&snapshot=0` for the plain boot)
 *   --pins    serve these pins.json instead of artifacts/pins.json (with
 *             the blobs and snapshots they name installed)
 *   --warm    repeat loads after the cold one (default 1)
 *
 * Needs the pinned blobs and, for a restore, the pinned snapshots in
 * public/snapshot/ (YURT_INSTALL_SNAPSHOT=1 scripts/install-pinned-artifacts.sh)
 * and Playwright's browsers. Memory is sampled with `ps` (macOS, Linux).
 */
import { ensureBundle } from "./serve.ts";
import { handlePlaygroundRequest, ISOLATION_HEADERS } from "../src/serve.ts";

const DEVICES = {
  phone: "iPhone 13",
  tablet: "iPad Pro 11",
  desktop: "Desktop Chrome",
} as const;

function option(name: string, fallback: string): string {
  const at = Deno.args.indexOf(name);
  return at < 0 ? fallback : Deno.args[at + 1] ?? fallback;
}

/** Resident MiB of the renderer processes under the browser started with
 * `profile`: what the page and its workers hold, wasm memory included. */
function rendererMiB(profile: string): number {
  const out = new TextDecoder().decode(
    new Deno.Command("ps", {
      args: ["-axo", "pid=,ppid=,rss=,command="],
      stdout: "piped",
    }).outputSync().stdout,
  );
  const rows = out.split("\n").filter(Boolean).map((line) => {
    const [pid, ppid, rss, ...command] = line.trim().split(/\s+/);
    return { pid, ppid, rss: Number(rss), command: command.join(" ") };
  });
  const browsers = new Set(
    rows.filter((row) =>
      row.command.includes(profile) && !row.command.includes("--type=")
    ).map((row) => row.pid),
  );
  return rows.filter((row) =>
    browsers.has(row.ppid) && row.command.includes("--type=renderer")
  ).reduce((sum, row) => sum + row.rss, 0) / 1024;
}

if (import.meta.main) {
  const device = option("--device", "phone") as keyof typeof DEVICES;
  const engine = option("--engine", "chromium") as "chromium" | "webkit";
  const query = option("--query", "start&start-anyway");
  const pinsPath = option("--pins", "");
  const warm = Number(option("--warm", "1"));
  const { chromium, webkit, devices } = await import("playwright");
  await ensureBundle();
  const pins = pinsPath === ""
    ? undefined
    : JSON.parse(await Deno.readTextFile(pinsPath));
  const server = Deno.serve(
    { port: 0, hostname: "127.0.0.1", onListen: () => {} },
    (request) =>
      pins !== undefined && new URL(request.url).pathname === "/pins.json"
        ? Response.json(pins, { headers: ISOLATION_HEADERS })
        : handlePlaygroundRequest(request),
  );
  const profile = await Deno.makeTempDir({ prefix: "yurt-measure-boot-" });
  const descriptor = { ...devices[DEVICES[device]] };
  // WebKit takes no isMobile; the viewport, UA and touch stay.
  if (engine === "webkit") {
    delete (descriptor as { isMobile?: boolean }).isMobile;
  }
  const context = await (engine === "chromium" ? chromium : webkit)
    .launchPersistentContext(profile, { ...descriptor, headless: true });
  try {
    const page = context.pages()[0] ?? await context.newPage();
    let logs: string[] = [];
    page.on("console", (message) => logs.push(message.text()));
    for (let load = 0; load <= warm; load++) {
      logs = [];
      let peak = 0;
      const sampler = engine === "chromium"
        ? setInterval(() => peak = Math.max(peak, rendererMiB(profile)), 50)
        : undefined;
      const started = performance.now();
      await page.goto(`http://127.0.0.1:${server.addr.port}/?${query}`);
      await page.waitForFunction(
        () =>
          /running/.test(document.querySelector("#status")?.textContent ?? ""),
        undefined,
        { timeout: 300_000, polling: 50 },
      );
      await page.locator(".xterm-helper-textarea").first().focus();
      await page.keyboard.type("echo READY-$((6*7))\n");
      await page.waitForFunction(
        () =>
          /READY-42/.test(document.querySelector("#term")?.textContent ?? ""),
        undefined,
        { timeout: 120_000, polling: 50 },
      );
      const seconds = (performance.now() - started) / 1000;
      if (sampler !== undefined) clearInterval(sampler);
      console.log(JSON.stringify({
        device,
        engine,
        query,
        load: load === 0 ? "cold" : "warm",
        secondsToPrompt: Number(seconds.toFixed(2)),
        peakRendererMiB: engine === "chromium" ? Math.round(peak) : null,
        snapshot: logs.find((line) => /bytes of kernel memory/.test(line)) ??
          null,
        fellBack: logs.find((line) => /booting the image instead/.test(line)) ??
          null,
        remark: await page.locator("#linux-remark-text").textContent(),
      }));
    }
  } finally {
    await context.close();
    await server.shutdown();
    await Deno.remove(profile, { recursive: true });
  }
}
