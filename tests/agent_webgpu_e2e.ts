/**
 * The agent pane on a real GPU (#140). Nothing is stubbed: the static build,
 * served with its `_headers` the way Cloudflare Pages serves it; the
 * browser's own WebGPU adapter; the real inference worker and runtime; and
 * the weights from Hugging Face. One scene, in real Chrome (Playwright's
 * `chrome` channel) and in real Safari (W3C WebDriver to `safaridriver`;
 * Playwright's WebKit is not Safari): the pane loads the model to `loaded`,
 * then answers a task by running a command in the sandbox. A browser
 * without an adapter fails the scene.
 *
 * tests/agent_e2e.ts is the tool loop's check (command, answer, Stop) with
 * a scripted worker; this is the GPU's. It is not in CI: GitHub's runners
 * have no GPU and no Safari. Run it on a Mac:
 *
 *   deno run --allow-all tests/agent_webgpu_e2e.ts \
 *     [--model E2B|E4B] [--browser chrome|safari] [--no-build] [--headed]
 *
 * Safari needs Settings → Developer → "Allow remote automation" and an
 * unlocked screen (a locked Mac times the session out). Chrome keeps its
 * profile under ~/Library/Caches/yurt-playground/ on one port, so its
 * second run finds the weights cached (loaded in ~2 s on an M4). A Safari
 * automation session starts with empty storage and downloads every time.
 */
import { chromium } from "playwright";
import { extname, join } from "node:path";
import { buildStaticSite } from "../scripts/build-static.ts";

const flag = (name: string) => {
  const at = Deno.args.indexOf(`--${name}`);
  return at < 0 ? undefined : Deno.args[at + 1];
};
const MODEL = flag("model") ?? "E2B";
const BROWSERS = flag("browser") ? [flag("browser")!] : ["chrome", "safari"];
// Not 4190: that is ManageSieve, on the Fetch standard's bad-port list,
// and Safari silently stays on about:blank.
const PORT = 4183;
const DRIVER_PORT = 4445;
const TASK = "How many lines does /etc/passwd have?";
const distDir = new URL("../dist/", import.meta.url).pathname;

/** dist/ with its `_headers` applied: a path rule, then `  Name: value`
 * lines, or `  ! Name` to detach one set by an earlier rule. */
async function serveDist(): Promise<Deno.HttpServer> {
  type Rule = { prefix: string; ops: [string, string | null][] };
  const rules: Rule[] = [];
  const text = await Deno.readTextFile(join(distDir, "_headers"));
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    if (!line.startsWith(" ")) {
      rules.push({ prefix: line.replace(/\*$/, ""), ops: [] });
    } else if (line.trim().startsWith("!")) {
      rules.at(-1)!.ops.push([line.trim().slice(1).trim(), null]);
    } else {
      const [name, ...value] = line.trim().split(":");
      rules.at(-1)!.ops.push([name, value.join(":").trim()]);
    }
  }
  const types: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".wasm": "application/wasm",
    ".svg": "image/svg+xml",
    ".gz": "application/gzip",
  };
  return Deno.serve(
    { port: PORT, hostname: "127.0.0.1", onListen: () => {} },
    async (req) => {
      let path = decodeURIComponent(new URL(req.url).pathname);
      if (path.endsWith("/")) path += "index.html";
      const headers = new Headers();
      for (const rule of rules) {
        if (!path.startsWith(rule.prefix)) continue;
        for (const [name, value] of rule.ops) {
          if (value === null) headers.delete(name);
          else headers.append(name, value);
        }
      }
      if (path.split("/").includes("..")) {
        return new Response("not found", { status: 404, headers });
      }
      try {
        const file = await Deno.open(join(distDir, path));
        if (!(await file.stat()).isFile) {
          file.close();
          throw new Error("not a file");
        }
        headers.set(
          "content-type",
          types[extname(path)] ?? "application/octet-stream",
        );
        return new Response(file.readable, { headers });
      } catch {
        return new Response("not found", { status: 404, headers });
      }
    },
  );
}

/** What a scene needs from a browser: navigate, and run an async function
 * body in the page, getting its JSON result back. */
type Driver = {
  version: string;
  goto(url: string): Promise<void>;
  run<T>(body: string): Promise<T>;
  close(): Promise<void>;
};

async function chrome(headed: boolean): Promise<Driver> {
  const profile = join(
    Deno.env.get("HOME")!,
    "Library/Caches/yurt-playground/agent-webgpu-chrome",
  );
  await Deno.mkdir(profile, { recursive: true });
  const context = await chromium.launchPersistentContext(profile, {
    channel: "chrome",
    headless: !headed,
    args: ["--enable-unsafe-webgpu"],
  });
  const page = context.pages()[0] ?? await context.newPage();
  return {
    version: `Chrome ${context.browser()?.version() ?? ""}`.trim(),
    goto: async (url) => void await page.goto(url),
    // An expression string, evaluated over DevTools: the page's CSP has no
    // 'unsafe-eval', so `new Function` in the page would be refused.
    run: (body) => page.evaluate(`(async () => {${body}})()`),
    close: () => context.close(),
  };
}

async function safari(): Promise<Driver> {
  const base = `http://127.0.0.1:${DRIVER_PORT}`;
  const wd = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await response.json();
    if (!response.ok) {
      throw new Error(`${method} ${path}: ${JSON.stringify(json.value)}`);
    }
    return json.value;
  };
  const driver = new Deno.Command("safaridriver", {
    args: ["-p", String(DRIVER_PORT)],
    stdout: "null",
    stderr: "null",
  }).spawn();
  for (let i = 0; i < 100; i++) {
    if (await fetch(`${base}/status`).then((r) => r.ok, () => false)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  let session: string;
  try {
    const created = await wd("POST", "/session", {
      capabilities: { alwaysMatch: { browserName: "safari" } },
    });
    session = created.sessionId;
    await wd("POST", `/session/${session}/timeouts`, { script: 120_000 });
    const caps = created.capabilities;
    return {
      version: `Safari ${caps.browserVersion ?? ""}`.trim(),
      // Returning from the navigation is not the page being there: wait
      // until a script in it reports the URL.
      goto: async (url) => {
        await wd("POST", `/session/${session}/url`, { url });
        const seen: string[] = [];
        for (let i = 0; i < 50; i++) {
          const href = await wd("POST", `/session/${session}/execute/sync`, {
            script: "return location.href",
            args: [],
          }).catch((e) => `error ${e}`);
          if (href === url) return;
          if (seen.at(-1) !== href) seen.push(href);
          await new Promise((r) => setTimeout(r, 200));
        }
        const at = await wd("GET", `/session/${session}/url`).catch(String);
        throw new Error(
          `Safari did not reach ${url}: scripts saw ${
            JSON.stringify(seen)
          }, the session says ${at}`,
        );
      },
      run: async (body) => {
        // {ok, value}: a page-side throw stays a message, not a lost stack.
        const r = await wd("POST", `/session/${session}/execute/async`, {
          script: `const done = arguments[arguments.length - 1];
            (async () => {${body}})()
              .then((value) => done({ ok: true, value }),
                (e) => done({ ok: false, value: String(e) }));`,
          args: [],
        }).then(
          (v) => v as { ok: boolean; value: unknown },
        );
        if (!r.ok) throw new Error(String(r.value));
        return r.value as never;
      },
      close: async () => {
        await wd("DELETE", `/session/${session}`).catch(() => {});
        driver.kill();
      },
    };
  } catch (error) {
    driver.kill();
    throw error;
  }
}

// Page-side steps, as async function bodies; values are spliced in as JSON.
const PANE = `
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (document.querySelector("[data-testid=agent-start]")) return "start";
    if (document.querySelector("[data-testid=agent-unsupported]")) {
      return "unsupported";
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return "timeout";`;
const ADAPTER = `
  const adapter = await navigator.gpu?.requestAdapter();
  if (!adapter) {
    // Why not, for the failure message.
    return "none: " + JSON.stringify({ url: location.href,
      gpu: typeof navigator.gpu, secure: isSecureContext,
      isolated: crossOriginIsolated });
  }
  const i = adapter.info ?? {};
  return [i.vendor, i.architecture, i.description].filter(Boolean).join(" ") ||
    "unnamed adapter";`;
const START = (model: string) => `
  const select = document.querySelector("#agent-model");
  select.value = ${JSON.stringify(model)};
  select.dispatchEvent(new Event("change"));
  await new Promise((r) => setTimeout(r, 300));
  const button = document.querySelector("[data-testid=agent-start]");
  const label = button.textContent;
  button.click();
  return label;`;
const STATE = `
  const root = document.querySelector("#agent");
  return {
    ready: "agentReady" in root.dataset,
    runtime: root.dataset.agentRuntime ?? null,
    fromCache: root.dataset.agentFromCache ?? null,
    status: document.querySelector("[data-testid=agent-status]").textContent,
  };`;
const RUN = (task: string) => `
  const box = document.querySelector("[data-testid=agent-task]");
  box.value = ${JSON.stringify(task)};
  document.querySelector("[data-testid=agent-run]").click();
  return true;`;
const RESULT = `
  const answer = document.querySelector("[data-testid=agent-answer]");
  const transcript = document.querySelector("#agent-transcript");
  const text = transcript?.textContent ?? "";
  const over = answer !== null || /stopped|limit|failed/.test(text);
  return {
    over,
    answer: answer?.textContent ?? null,
    calls: [...document.querySelectorAll("#agent-transcript .call")]
      .map((c) => c.textContent),
    transcript: transcript?.innerText ?? "",
  };`;
const TRUTH = `
  const r = await globalThis.yurt.exec("wc -l < /etc/passwd");
  return r.stdout.trim();`;

type Report = {
  browser: string;
  adapter?: string;
  runtime?: string | null;
  fromCache?: string | null;
  loadSeconds?: number;
  taskSeconds?: number;
  calls?: string[];
  answer?: string | null;
  truth?: string;
  ok: boolean;
  error?: string;
};

async function scene(driver: Driver, url: string): Promise<Report> {
  const report: Report = { browser: driver.version, ok: false };
  const say = (s: string) => console.error(`  [${driver.version}] ${s}`);
  await driver.goto(url);
  report.adapter = await driver.run<string>(ADAPTER);
  say(`adapter: ${report.adapter}`);
  if (report.adapter.startsWith("none")) {
    throw new Error(`no WebGPU adapter (${report.adapter})`);
  }
  const pane = await driver.run<string>(PANE);
  if (pane !== "start") throw new Error(`the pane showed ${pane}`);
  say(await driver.run<string>(START(MODEL)));
  let started = performance.now();
  let last = "";
  let quarter = -1;
  for (;;) {
    const s = await driver.run<{
      ready: boolean;
      runtime: string | null;
      fromCache: string | null;
      status: string;
    }>(STATE);
    if (s.ready) {
      report.runtime = s.runtime;
      report.fromCache = s.fromCache;
      break;
    }
    if (s.status.startsWith("failed")) throw new Error(s.status);
    // Say each phase, and the download at every quarter.
    const got = /downloading ([\d.]+) \/ ([\d.]+)/.exec(s.status);
    const q = got ? Math.floor(4 * Number(got[1]) / Number(got[2])) : -1;
    if (got ? q !== quarter : s.status !== last) say(s.status);
    quarter = q;
    last = s.status;
    if (performance.now() - started > 20 * 60_000) {
      throw new Error(`not loaded after 20 min: ${s.status}`);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  report.loadSeconds = Math.round((performance.now() - started) / 1000);
  say(
    `loaded in ${report.loadSeconds} s: ${report.runtime}, ` +
      `weights ${report.fromCache === "true" ? "cached" : "downloaded"}`,
  );
  await driver.run(RUN(TASK));
  started = performance.now();
  let result: {
    over: boolean;
    answer: string | null;
    calls: string[];
    transcript: string;
  };
  for (;;) {
    result = await driver.run(RESULT);
    if (result.over) break;
    if (performance.now() - started > 180_000) {
      throw new Error(`no answer after 3 min:\n${result.transcript}`);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  report.taskSeconds = Math.round((performance.now() - started) / 1000);
  report.calls = result.calls;
  report.answer = result.answer;
  report.truth = await driver.run<string>(TRUTH);
  say(
    `ran ${JSON.stringify(result.calls)}, answered ${
      JSON.stringify(result.answer)
    } (truth ${report.truth})`,
  );
  const ranCommand = result.calls.some((c) => c.includes("/etc/passwd"));
  const right = new RegExp(`\\b${report.truth}\\b`).test(result.answer ?? "");
  if (!ranCommand || !right) {
    throw new Error(`wrong or unchecked answer:\n${result.transcript}`);
  }
  report.ok = true;
  return report;
}

if (import.meta.main) {
  if (!Deno.args.includes("--no-build")) {
    console.error("building dist/ (deno task build-static)");
    await buildStaticSite();
  }
  const server = await serveDist();
  const url = `http://127.0.0.1:${PORT}/`;
  const reports: Report[] = [];
  try {
    for (const browser of BROWSERS) {
      console.error(`${browser}: ${MODEL}`);
      let driver: Driver | undefined;
      try {
        driver = browser === "safari"
          ? await safari()
          : await chrome(Deno.args.includes("--headed"));
        reports.push(await scene(driver, url));
      } catch (error) {
        reports.push({
          browser: driver?.version ?? browser,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
        console.error(`  ${browser} FAILED: ${reports.at(-1)!.error}`);
      } finally {
        await driver?.close();
      }
    }
  } finally {
    await server.shutdown();
  }
  console.log(JSON.stringify({ model: MODEL, reports }, null, 2));
  if (!reports.every((r) => r.ok)) Deno.exit(1);
}
