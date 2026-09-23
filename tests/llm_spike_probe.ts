/**
 * Drives public/llm-spike.html (#140 feasibility gate) in a real browser
 * and writes the measurements as JSON. Manual, not part of `deno test`: it
 * needs a GPU and the multi-gigabyte model from scripts/fetch-llm-spike.sh.
 *
 *   deno run -A tests/llm_spike_probe.ts [E2B|E4B] [--headed] [--out f.json]
 *
 * One fresh profile per run, so the first load is cold. The sequence: cold
 * load, action schema, map step, sandbox + Jupyter boot, tool loop; then a
 * reload (the weights must come from Cache Storage), a new sandbox, and
 * the browser offline for one more generation and tool call, counting
 * every request the browser makes meanwhile.
 */
import { chromium } from "playwright";
import { ensureBundle } from "../scripts/serve.ts";
import { startPlaygroundServer } from "../src/serve.ts";

const flag = (name: string) => {
  const at = Deno.args.indexOf(`--${name}`);
  return at < 0 ? undefined : Deno.args[at + 1];
};
const headed = Deno.args.includes("--headed");
const model = Deno.args.find((a) => !a.startsWith("--") && a !== flag("out")) ??
  "E2B";
const out = flag("out") ?? `llm-spike-${model}.json`;

await ensureBundle();
const server = startPlaygroundServer(0);
const profile = await Deno.makeTempDir({ prefix: "llm-spike-profile-" });
const context = await chromium.launchPersistentContext(profile, {
  channel: "chrome",
  headless: !headed,
  args: ["--enable-unsafe-webgpu"],
});
const requests: { phase: string; url: string }[] = [];
let phase = "online";
context.on("request", (r) => requests.push({ phase, url: r.url() }));
const page = context.pages()[0] ?? await context.newPage();
page.on("console", (m) => {
  if (m.type() === "error") console.error(`[page] ${m.text()}`);
});
page.on("pageerror", (e) => console.error(`[pageerror] ${e.message}`));

const report: Record<string, unknown> = { model };

/** Each of this profile's browser processes and the kernel's record of
 * its peak physical footprint (macOS `footprint`), in MB. The page's own
 * memory API cannot see GPU buffers; this counts them. */
async function footprintPeaks(): Promise<Record<string, number>> {
  const run = async (cmd: string, args: string[]) =>
    new TextDecoder().decode(
      (await new Deno.Command(cmd, { args, stdout: "piped" }).output()).stdout,
    );
  const peaks: Record<string, number> = {};
  for (const line of (await run("ps", ["-axo", "pid=,command="])).split("\n")) {
    if (!line.includes(profile)) continue;
    const pid = line.trim().split(/\s+/)[0];
    const type = /--type=([\w-]+)/.exec(line)?.[1] ?? "browser";
    const peak = /phys_footprint_peak: (\d+) MB/.exec(
      await run("footprint", ["--noCategories", pid]),
    );
    if (peak !== null) peaks[`${type}:${pid}`] = Number(peak[1]);
  }
  return peaks;
}
const step = async <T>(name: string, fn: () => Promise<T>) => {
  const started = performance.now();
  console.error(`→ ${name}`);
  try {
    const value = await fn();
    console.error(
      `  ${name} ${Math.round(performance.now() - started)} ms`,
    );
    return value;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`  ${name} FAILED: ${message}`);
    report[`${name}_error`] = message;
    return undefined;
  }
};
// deno-lint-ignore no-explicit-any
type Spike = any;
const spike = <T>(fn: string, ...params: unknown[]) =>
  page.evaluate(
    ([fn, params]) =>
      // deno-lint-ignore no-explicit-any
      ((globalThis as any).llmSpike as Spike)[fn as string](
        ...(params as unknown[]),
      ),
    [fn, params] as const,
  ) as Promise<T>;

try {
  const open = async () => {
    await page.goto(`${server.url}/llm-spike.html`);
    await page.waitForFunction(() => "llmSpike" in globalThis);
  };
  await open();
  report.env = await spike("env");
  report.coldLoad = await step("cold load", () => spike("load", model));
  if (report.coldLoad === undefined) throw new Error("the model did not load");
  report.memoryModel = await step("memory", () => spike("memory", "model"));
  report.actions = await step("actions", () => spike("actions"));
  report.map120 = await step("map 120", () => spike("map", 120));
  report.map300 = await step("map 300", () => spike("map", 300));
  report.boot = await step("boot", () => spike("boot"));
  report.memorySandbox = await step(
    "memory",
    () => spike("memory", "model+sandbox"),
  );
  report.loop = await step("loop", () => spike("loop"));

  await open();
  report.cachedLoad = await step("cached load", () => spike("load", model));
  await step("boot again", () => spike("boot"));
  phase = "offline";
  await context.setOffline(true);
  report.offline = await step("offline run", () => spike("offlineRun"));
  await context.setOffline(false);
  report.offlineRequests = requests.filter((r) => r.phase === "offline");
} finally {
  if (Deno.build.os === "darwin") {
    report.footprintPeakMB = await footprintPeaks();
  }
  await Deno.writeTextFile(out, JSON.stringify(report, null, 2));
  console.error(`wrote ${out}`);
  await context.close();
  await server.shutdown();
  await Deno.remove(profile, { recursive: true });
}
