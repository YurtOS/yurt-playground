/**
 * tests/llm_spike_probe.ts for real Safari: Playwright's WebKit is not
 * Safari, so this speaks W3C WebDriver to `safaridriver` directly. Needs
 * Safari → Settings → Developer → "Allow remote automation". WebDriver has
 * no offline switch, so the offline step is left out.
 *
 *   deno run -A tests/llm_spike_safari.ts [E2B|E4B] [--out f.json]
 */
import { ensureBundle } from "../scripts/serve.ts";
import { startPlaygroundServer } from "../src/serve.ts";

const flag = (name: string) => {
  const at = Deno.args.indexOf(`--${name}`);
  return at < 0 ? undefined : Deno.args[at + 1];
};
const model = Deno.args.find((a) => !a.startsWith("--") && a !== flag("out")) ??
  "E2B";
const out = flag("out") ?? `llm-spike-safari-${model}.json`;
const DRIVER = "http://127.0.0.1:4444";

async function wd(method: string, path: string, body?: unknown) {
  const response = await fetch(`${DRIVER}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await response.json();
  if (!response.ok) {
    throw new Error(`${method} ${path}: ${JSON.stringify(json.value)}`);
  }
  return json.value;
}

await ensureBundle();
const server = startPlaygroundServer(0);
const driver = new Deno.Command("safaridriver", {
  args: ["-p", "4444"],
  stdout: "null",
  stderr: "null",
}).spawn();
for (let i = 0; i < 50; i++) {
  const ready = await fetch(`${DRIVER}/status`).then((r) => r.ok, () => false);
  if (ready) break;
  await new Promise((r) => setTimeout(r, 100));
}

const report: Record<string, unknown> = { model, browser: "safari" };
let session: string | undefined;
try {
  session = (await wd("POST", "/session", {
    capabilities: { alwaysMatch: { browserName: "safari" } },
  })).sessionId as string;
  await wd("POST", `/session/${session}/timeouts`, { script: 900_000 });
  await wd("POST", `/session/${session}/url`, {
    url: `${server.url}/llm-spike.html`,
  });
  // Resolves with {ok, value} so a page-side failure is data, not a
  // WebDriver error that loses the message.
  const spike = (fn: string, ...params: unknown[]) =>
    wd("POST", `/session/${session}/execute/async`, {
      script: `const done = arguments[arguments.length - 1];
        const [fn, params] = arguments;
        const wait = () => globalThis.llmSpike
          ? globalThis.llmSpike[fn](...params)
            .then((value) => done({ ok: true, value }),
              (e) => done({ ok: false, value: String(e) + "\\n" + (e && e.stack) }))
          : setTimeout(wait, 100);
        wait();`,
      args: [fn, params],
    }) as Promise<{ ok: boolean; value: unknown }>;
  const step = async (name: string, fn: string, ...params: unknown[]) => {
    const started = performance.now();
    console.error(`→ ${name}`);
    const result = await spike(fn, ...params).catch((e) => ({
      ok: false,
      value: String(e),
    }));
    console.error(
      `  ${name} ${result.ok ? "" : "FAILED "}${
        Math.round(performance.now() - started)
      } ms`,
    );
    report[name] = result.ok ? result.value : { error: result.value };
    return result.ok;
  };
  await step("env", "env");
  if (await step("coldLoad", "load", model)) {
    await step("actions", "actions");
    await step("map120", "map", 120);
    await step("map300", "map", 300);
    await step("boot", "boot");
    await step("loop", "loop");
    await wd("POST", `/session/${session}/refresh`, {});
    await step("cachedLoad", "load", model);
  }
} catch (error) {
  report.error = String(error);
  console.error(report.error);
} finally {
  await Deno.writeTextFile(out, JSON.stringify(report, null, 2));
  console.error(`wrote ${out}`);
  if (session !== undefined) {
    await wd("DELETE", `/session/${session}`).catch(() => {});
  }
  driver.kill();
  await server.shutdown();
}
