/**
 * The home page's agent pane (#140), end to end in headless Chromium, with
 * no model weights: the test answers `/llm/models.json` and serves a
 * scripted stand-in for `/llm_worker.bundle.js` that speaks the worker's
 * protocol. Everything else is real: the pane, the client, the controller
 * and the sandbox the agent's commands run in. Scenes: no WebGPU, a model
 * that fails to start, Enter vs Shift+Enter, a task answered through a real
 * command (starting the sandbox on the way), and Stop killing a command.
 * Run: `deno run --allow-all tests/agent_e2e.ts` (needs the kernel checkout
 * and pinned artifacts like playground_e2e.ts).
 */
import { type BrowserContext, chromium, type Page } from "playwright";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureBundle } from "../scripts/serve.ts";
import { ISOLATION_HEADERS, startPlaygroundServer } from "../src/serve.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** A worker that loads nothing and replies from a script: run a command,
 * then answer with the last number the command printed; or, for a task
 * that says "sleep", run one that never ends on its own. */
function fakeWorker(mode: "ok" | "fail"): string {
  return `
self.onmessage = (event) => {
  const m = event.data;
  if (m.type === "cancel") return;
  if (m.type === "load") {
    if (${JSON.stringify(mode)} === "fail") {
      self.postMessage({ type: "error", message: "out of GPU memory" });
      return;
    }
    self.postMessage({ type: "progress", loaded: 1, total: 1 });
    self.postMessage({ type: "loaded", wasmVariant: "fake", fromCache: false,
      downloadBytes: 1, downloadMs: 1, wasmMs: 1, engineMs: 1 });
    return;
  }
  let text;
  if (m.prompt.includes("sleep")) {
    text = '{"action":"exec","cmd":"sleep 60"}';
  } else if (m.prompt.includes("Result:")) {
    const numbers = m.prompt.split("Result:").pop().match(/\\d+/g);
    text = JSON.stringify({ action: "answer", text: numbers.pop() });
  } else {
    text = '{"action":"exec","cmd":"wc -l < /etc/passwd"}';
  }
  self.postMessage({ type: "token", id: m.id, text });
  self.postMessage({ type: "done", id: m.id, text, firstTokenMs: 1,
    wallMs: 1, bench: { lastPrefillTokensPerSecond: 1,
      lastPrefillTokenCount: m.prompt.length, lastDecodeTokensPerSecond: 1,
      lastDecodeTokenCount: 5, timeToFirstTokenInSecond: 0.001 } });
};`;
}

async function withModel(
  context: BrowserContext,
  opts: { worker: "ok" | "fail"; webgpu: boolean },
): Promise<void> {
  await context.route("**/llm/models.json", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(["E4B"]),
    }));
  await context.route("**/llm_worker.bundle.js", (route) =>
    route.fulfill({
      // A worker of a cross-origin-isolated page needs the headers too.
      headers: ISOLATION_HEADERS,
      contentType: "text/javascript",
      body: fakeWorker(opts.worker),
    }));
  // Headless Chromium on a runner has no GPU; the pane asks for an adapter.
  await context.addInitScript((webgpu: boolean) => {
    Object.defineProperty(Navigator.prototype, "gpu", {
      configurable: true,
      get: () => ({
        requestAdapter: () => Promise.resolve(webgpu ? {} : null),
      }),
    });
  }, opts.webgpu);
}

async function until(
  page: Page,
  what: string,
  fn: () => boolean,
  timeout = 30_000,
): Promise<void> {
  try {
    await page.waitForFunction(fn, null, { timeout, polling: 100 });
  } catch {
    throw new Error(
      `agent e2e: ${what} did not happen; pane: ${await page.innerText(
        "#agent",
      ).catch(() => "?")}`,
    );
  }
}

if (import.meta.main) {
  await ensureBundle(
    Deno.env.get("YURT_KERNEL_ROOT") ?? join(repoRoot, "../yurtos-kernel"),
  );
  const server = startPlaygroundServer(0);
  const browser = await chromium.launch();
  try {
    // No model on offer (the hosted site, the desktop app): no pane at all.
    {
      const context = await browser.newContext();
      await context.route(
        "**/llm/models.json",
        (route) => route.fulfill({ status: 404, body: "not found" }),
      );
      const page = await context.newPage();
      await page.goto(`${server.url}/`);
      await page.waitForFunction(() => "yurt" in globalThis);
      await page.waitForTimeout(500);
      if (await page.locator("#agent").isVisible()) {
        throw new Error("agent e2e: the pane shows with no model on offer");
      }
      await context.close();
    }

    // A model on offer but no WebGPU: said, not silently hidden.
    {
      const context = await browser.newContext();
      await withModel(context, { worker: "ok", webgpu: false });
      const page = await context.newPage();
      await page.goto(`${server.url}/`);
      await page.locator("[data-testid=agent-unsupported]").waitFor();
      if (await page.locator("[data-testid=agent-start]").count() !== 0) {
        throw new Error("agent e2e: a start button without WebGPU");
      }
      await context.close();
    }

    // The model fails to start: the reason, and the button back.
    {
      const context = await browser.newContext();
      await withModel(context, { worker: "fail", webgpu: true });
      const page = await context.newPage();
      await page.goto(`${server.url}/`);
      const cost = await page.locator("[data-testid=agent-cost]").innerText();
      if (!/Needs about 8 GB/.test(cost)) {
        throw new Error(`agent e2e: no memory cost before download: ${cost}`);
      }
      await page.locator("[data-testid=agent-start]").click();
      await until(
        page,
        "the start failure",
        () =>
          document.querySelector("[data-testid=agent-status]")?.textContent ===
            "failed: out of GPU memory" &&
          !(document.querySelector("[data-testid=agent-start]") as
            | HTMLButtonElement
            | null)?.disabled,
      );
      await context.close();
    }

    // The working path, starting the sandbox from Run.
    const context = await browser.newContext();
    await withModel(context, { worker: "ok", webgpu: true });
    const page = await context.newPage();
    await page.goto(`${server.url}/`);
    await page.locator("[data-testid=agent-start]").click();
    await page.locator("#agent[data-agent-ready]").waitFor();
    const task = page.locator("[data-testid=agent-task]");
    await task.fill("count the lines in /etc/passwd");
    await task.press("Shift+Enter");
    if (
      !(await task.inputValue()).includes("\n") ||
      await page.locator("#agent-transcript li").count() !== 0
    ) {
      throw new Error("agent e2e: Shift+Enter ran the task");
    }
    await task.press("Enter");
    await until(
      page,
      "an answer",
      () => document.querySelector("[data-testid=agent-answer]") !== null,
      180_000,
    );
    const call = await page.locator("#agent-transcript .call").innerText();
    const answer = await page.locator("[data-testid=agent-answer]")
      .innerText();
    const truth = await page.evaluate(() =>
      (globalThis as unknown as {
        yurt: { exec(c: string): Promise<{ stdout: string }> };
      }).yurt.exec("wc -l < /etc/passwd").then((r) => r.stdout.trim())
    );
    if (!call.includes("wc -l < /etc/passwd") || answer !== truth) {
      throw new Error(
        `agent e2e: ran ${JSON.stringify(call)}, answered ${
          JSON.stringify(answer)
        }, the sandbox says ${truth}`,
      );
    }

    // Stop: the command dies, the transcript says so.
    await task.fill("sleep for a minute");
    await task.press("Enter");
    await until(
      page,
      "the sleep to start",
      () => document.querySelector("#agent-transcript .call") !== null,
    );
    await page.waitForFunction(() =>
      (globalThis as unknown as {
        yurt: { list(): Promise<unknown[]> };
      }).yurt.list().then((l) => l.length > 0)
    );
    await page.locator("[data-testid=agent-stop]").click();
    await until(
      page,
      "the stop",
      () =>
        document.querySelector("#agent-transcript .stopped")?.textContent ===
          "stopped",
    );
    await until(page, "the sleep to be killed", () => {
      const probe = globalThis as unknown as {
        __left?: number;
        yurt: { list(): Promise<unknown[]> };
      };
      void probe.yurt.list().then((l) => (probe.__left = l.length));
      return probe.__left === 0;
    }, 15_000);
    console.log(
      `agent e2e: ran ${call}, answered ${answer}; Stop killed the sleep`,
    );
    await context.close();
  } finally {
    await browser.close();
    await server.shutdown();
  }
}
