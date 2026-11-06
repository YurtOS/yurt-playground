/**
 * The home page's agent pane (#140), end to end in headless Chromium, with
 * no model weights: the test answers `/llm/models.json` and serves a
 * scripted stand-in for `/llm_worker.bundle.js` that speaks the worker's
 * protocol. Everything else is real: the pane, the client, the controller
 * and the sandbox the agent's commands run in. Scenes: no WebGPU, a model
 * that fails to start, Enter vs Shift+Enter, a task answered through a real
 * command (starting the sandbox on the way), Stop killing a command, and a
 * model in Ollama, which the page leaves alone until asked.
 * This checks the tool loop and the pane, not the GPU: the adapter below
 * is a stub and the worker never creates a device. The model on a real
 * adapter, in real Chrome and Safari, is tests/agent_webgpu_e2e.ts (a Mac,
 * not CI).
 * Run: `deno run --allow-all tests/agent_e2e.ts` (needs the kernel checkout
 * and pinned artifacts like playground_e2e.ts).
 */
import { type BrowserContext, chromium, type Page } from "playwright";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureBundle } from "../scripts/serve.ts";
import { DEMO_TEXT_PATH } from "../src/agent.ts";
import { OLLAMA_URL } from "../src/ollama.ts";
import { ISOLATION_HEADERS, startPlaygroundServer } from "../src/serve.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** A worker that loads nothing and replies from a script: run a command,
 * then answer with the last number the command printed; or, for a task
 * that says "sleep", run one that never ends on its own; for "two lines",
 * a command of two lines. */
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
  } else if (
    m.prompt.includes("two lines") &&
    !m.prompt.slice(m.prompt.lastIndexOf("two lines")).includes("Result:")
  ) {
    text = JSON.stringify({ action: "exec", cmd: "echo 1\\necho 2" });
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
  // A stub, so this proves nothing about WebGPU (agent_webgpu_e2e.ts does).
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
    // Each run ends sealed: the next message resumes the sandbox with its files
    // and the chat, and the PDF is still there to download while it is sealed.
    {
      const context = await browser.newContext();
      await withModel(context, { worker: "ok", webgpu: true });
      const prompts: string[] = [];
      await context.route(`${OLLAMA_URL}/**`, (route) => {
        const request = route.request();
        const cors = { "Access-Control-Allow-Origin": "*" };
        if (request.method() === "OPTIONS") {
          return route.fulfill({
            status: 204,
            headers: { ...cors, "Access-Control-Allow-Headers": "*" },
          });
        }
        if (request.url().endsWith("/api/tags")) {
          return route.fulfill({
            headers: cors,
            json: { models: [{ name: "stand-in:1" }] },
          });
        }
        const prompt: string = request.postDataJSON().messages[1].content;
        prompts.push(prompt);
        const reply = prompt.includes("Result:")
          ? { action: "answer", text: "Done." }
          : { action: "write_file", path: DEMO_TEXT_PATH, text: "kept across" };
        return route.fulfill({
          headers: cors,
          body:
            JSON.stringify({ message: { content: JSON.stringify(reply) } }) +
            "\n" + JSON.stringify({
              done: true,
              prompt_eval_count: 3,
              eval_count: 2,
            }) + "\n",
        });
      });
      const page = await context.newPage();
      const logs: string[] = [];
      page.on("console", (m) => logs.push(m.text()));
      await page.goto(`${server.url}/#agent`);
      await page.locator("[data-testid=agent-model]").selectOption("ollama");
      await page.locator("[data-testid=agent-start]").click();
      await page.locator("#agent[data-agent-ready]").waitFor();
      await page.evaluate(async () => {
        document.getElementById("start-sandbox")?.click();
        const yurt = (globalThis as unknown as {
          yurt: {
            ready: Promise<void>;
            exec(c: string, o: { stdin: string }): Promise<unknown>;
          };
        }).yurt;
        await yurt.ready;
        await yurt.exec(
          "sudo tee /usr/bin/mkpdf >/dev/null && sudo chmod 755 /usr/bin/mkpdf",
          { stdin: '#!/bin/sh\ncat > "$1"\n' },
        );
      });
      await page.locator("[data-testid=agent-run]").click();
      await page.locator("#agent[data-agent-suspended]").waitFor({
        timeout: 180_000,
      });
      if (!logs.some((l) => l.includes("[session] sealed in"))) {
        throw new Error("agent e2e: the run ended without a seal");
      }
      const saving = page.waitForEvent("download");
      await page.locator("[data-testid=agent-download]").click();
      if (
        await Deno.readTextFile(await (await saving).path()) !== "kept across"
      ) {
        throw new Error("agent e2e: the sealed PDF did not download");
      }
      await page.locator("[data-testid=agent-task]").fill("second message");
      await page.locator("[data-testid=agent-run]").click();
      await page.waitForFunction(
        () =>
          document.querySelectorAll("#agent-transcript .user").length === 2 &&
          document.querySelectorAll("#agent-transcript .answer").length === 2 &&
          document.querySelector("#agent")?.hasAttribute(
              "data-agent-suspended",
            ) === true,
        null,
        { timeout: 180_000, polling: 250 },
      );
      if (!logs.some((l) => l.includes("[session] resumed"))) {
        throw new Error("agent e2e: the second message did not resume");
      }
      // The file came through the seal: the model is shown it.
      if (!prompts.some((p) => p.includes("<<<\nkept across\n>>>"))) {
        throw new Error("agent e2e: the document did not survive the seal");
      }
      if (await page.locator("[data-testid=agent-download]").count() !== 1) {
        throw new Error("agent e2e: no Download after the resume");
      }
      // The transcript scrolls on its own, follows new output at the bottom, and
      // leaves the visitor where they scrolled to.
      const scroll = await page.evaluate(async () => {
        const list = document.querySelector("#agent-transcript") as HTMLElement;
        const add = async () => {
          for (let i = 0; i < 60; i++) {
            list.append(document.createElement("li"));
            list.lastElementChild!.textContent = "line";
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
        };
        await add();
        const atBottom = list.scrollHeight - list.scrollTop -
            list.clientHeight < 5;
        const page = document.documentElement.scrollHeight;
        list.scrollTop = 0;
        await new Promise((resolve) => setTimeout(resolve, 50));
        await add();
        const stayed = list.scrollTop === 0;
        const scrolls = list.scrollHeight > list.clientHeight;
        for (let i = 0; i < 120; i++) list.lastElementChild!.remove();
        return { atBottom, stayed, scrolls, page, view: innerHeight };
      });
      if (
        !scroll.atBottom || !scroll.stayed || !scroll.scrolls ||
        scroll.page > scroll.view + 400
      ) {
        throw new Error(`agent e2e: scrolling: ${JSON.stringify(scroll)}`);
      }
      // One write, then the answer: one agent call, two model calls, per message.
      const stats = await page.locator("[data-testid=agent-stats]")
        .allInnerTexts();
      if (
        stats.length !== 2 ||
        !stats.every((l) =>
          /^agent called 1 time · model called 2 times · [\d.]+ s$/.test(l)
        )
      ) {
        throw new Error(`agent e2e: stats read ${JSON.stringify(stats)}`);
      }
      // The Shell tab is another sandbox, with Jupyter's cell, and none of the
      // agent's files; going back finds the agent's session as it was.
      await page.locator("[data-testid=view-shell]").click();
      await page.waitForFunction(() => location.hash === "#shell");
      await page.locator("#start-sandbox").click();
      await page.waitForFunction(
        () =>
          (globalThis as unknown as { yurt?: { status: string } }).yurt
            ?.status === "running",
        null,
        { timeout: 60_000 },
      );
      if (!await page.locator("#notebook").isVisible()) {
        throw new Error("agent e2e: the Shell tab lost its Python cell");
      }
      const mixed = await page.evaluate(() =>
        (globalThis as unknown as {
          yurt: { exec(c: string): Promise<{ code: number }> };
        }).yurt.exec(`test -e /home/user/demo.txt`).then((r) => r.code)
      );
      if (mixed === 0) {
        throw new Error(
          "agent e2e: the agent's file is in the shell's sandbox",
        );
      }
      await page.locator("[data-testid=view-agent]").click();
      await page.locator("#agent[data-agent-ready]").waitFor();
      await page.locator("[data-testid=agent-download]").waitFor();
      // New session starts over. Not mid-boot: a reload then reads as a boot the
      // browser cut off.
      const sandboxRunning = () =>
        page.waitForFunction(
          () =>
            (globalThis as unknown as { yurt?: { status: string } }).yurt
              ?.status === "running",
          null,
          { timeout: 60_000 },
        );
      await sandboxRunning();
      await page.locator("[data-testid=agent-new-session]").click();
      await page.locator("[data-testid=agent-start]").waitFor();
      if (await page.locator("#agent-transcript li").count() !== 0) {
        throw new Error("agent e2e: New session kept the chat");
      }
      // So does a refresh, though the page's own reloads above resumed.
      await page.locator("[data-testid=agent-model]").selectOption("ollama");
      await page.locator("[data-testid=agent-start]").click();
      await page.locator("#agent[data-agent-ready]").waitFor();
      await page.locator("[data-testid=agent-run]").click();
      await page.locator("#agent[data-agent-suspended]").waitFor({
        timeout: 180_000,
      });
      await page.reload();
      await page.locator("[data-testid=agent-start]").waitFor();
      if (await page.locator("#agent-transcript li").count() !== 0) {
        throw new Error("agent e2e: a refresh kept the chat");
      }
      if (
        await page.evaluate(() =>
          localStorage.getItem("yurt-agent-session")
        ) !==
          null
      ) {
        throw new Error("agent e2e: a refresh kept the saved chat");
      }
      await context.close();
    }

    // No model on offer (the hosted site, the desktop app): no pane at all.
    {
      const context = await browser.newContext();
      await context.route(
        "**/llm/models.json",
        (route) => route.fulfill({ status: 404, body: "not found" }),
      );
      const page = await context.newPage();
      await page.goto(`${server.url}/?suspend=0#agent`);
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
      await page.goto(`${server.url}/?suspend=0#agent`);
      await page.locator("[data-testid=agent-unsupported]").waitFor();
      const offered = await page.locator("[data-testid=agent-model] option")
        .evaluateAll((options) =>
          options.map((o) => (o as HTMLOptionElement).value)
        );
      if (offered.join() !== "ollama") {
        throw new Error(`agent e2e: offered without WebGPU: ${offered}`);
      }
      await context.close();
    }

    // Ollama on this computer: not contacted until asked, a refusal says what
    // to do, and the model it lists does the task. Stand-in replies, because
    // the runners have no Ollama; the real one is tests/agent_ollama_e2e.ts.
    {
      const context = await browser.newContext();
      await withModel(context, { worker: "ok", webgpu: true });
      const asked: string[] = [];
      let refuse = true;
      await context.route(`${OLLAMA_URL}/**`, (route) => {
        const request = route.request();
        asked.push(new URL(request.url()).pathname);
        const cors = { "Access-Control-Allow-Origin": "*" };
        if (refuse) return route.abort("connectionrefused");
        if (request.method() === "OPTIONS") {
          return route.fulfill({
            status: 204,
            headers: { ...cors, "Access-Control-Allow-Headers": "*" },
          });
        }
        if (request.url().endsWith("/api/tags")) {
          return route.fulfill({
            headers: cors,
            json: { models: [{ name: "stand-in:1" }, { name: "other:2" }] },
          });
        }
        const { model, messages } = request.postDataJSON();
        if (model !== "stand-in:1") throw new Error(`asked ${model}`);
        // The first write finds no mkpdf; the answer ends each message.
        const prompt: string = messages[1].content;
        const reply =
          prompt.slice(prompt.lastIndexOf("Now the user asks")).includes(
              "Result:",
            ) ||
            (!prompt.includes("Now the user asks") &&
              prompt.includes("Result:"))
            ? { action: "answer", text: "Done." }
            : { action: "write_file", path: DEMO_TEXT_PATH, text: "made" };
        return route.fulfill({
          headers: cors,
          body:
            JSON.stringify({ message: { content: JSON.stringify(reply) } }) +
            "\n" + JSON.stringify({
              done: true,
              prompt_eval_count: 3,
              eval_count: 2,
            }) + "\n",
        });
      });
      const page = await context.newPage();
      await page.goto(`${server.url}/?suspend=0#agent`);
      await page.locator("[data-testid=agent-model]").selectOption("ollama");
      await page.waitForTimeout(500);
      if (asked.length !== 0) {
        throw new Error(`agent e2e: contacted Ollama unasked: ${asked}`);
      }
      await page.locator("[data-testid=agent-start]").click();
      await until(
        page,
        "the way to start Ollama",
        () =>
          document.querySelector("[data-testid=agent-cost]")?.textContent
              ?.includes("ollama serve") === true &&
          !(document.querySelector("[data-testid=agent-start]") as
            | HTMLButtonElement
            | null)?.disabled,
      );
      refuse = false;
      await page.locator("[data-testid=agent-start]").click();
      await page.locator("#agent[data-agent-ready]").waitFor();
      // A snapshot may hold mkpdf already: this scene starts without it.
      await page.evaluate(async () => {
        document.getElementById("start-sandbox")?.click();
        const yurt = (globalThis as unknown as {
          yurt: { ready: Promise<void>; exec(c: string): Promise<unknown> };
        }).yurt;
        await yurt.ready;
        await yurt.exec("sudo rm -f /usr/bin/mkpdf");
      });
      const task = await page.locator("[data-testid=agent-task]").inputValue();
      if (!task.includes("PDF")) {
        throw new Error(`agent e2e: the default task is not the demo: ${task}`);
      }
      await page.locator("[data-testid=agent-run]").click();
      await until(
        page,
        "the stop after a PDF that could not be made",
        () =>
          document.querySelector("#agent-transcript .stopped")?.textContent
            ?.includes("the PDF could not be made") === true,
        180_000,
      );
      if (await page.locator("[data-testid=agent-download]").count() !== 0) {
        throw new Error("agent e2e: a Download with no PDF");
      }
      // A stand-in for the package; a second message in the same chat.
      await page.evaluate(() =>
        (globalThis as unknown as {
          yurt: { exec(c: string, o: { stdin: string }): Promise<unknown> };
        }).yurt.exec(
          "sudo tee /usr/bin/mkpdf >/dev/null && sudo chmod 755 /usr/bin/mkpdf",
          { stdin: '#!/bin/sh\ncat > "$1"\n' },
        )
      );
      await page.locator("[data-testid=agent-task]").fill("again");
      await page.locator("[data-testid=agent-run]").click();
      await page.locator("[data-testid=agent-download]").waitFor({
        timeout: 180_000,
      });
      const label = await page.locator("[data-testid=agent-download]")
        .innerText();
      if (label !== "Download demo.pdf") {
        throw new Error(`agent e2e: download offered as: ${label}`);
      }
      const saving = page.waitForEvent("download");
      await page.locator("[data-testid=agent-download]").click();
      const saved = await saving;
      const content = await Deno.readTextFile(await saved.path());
      if (saved.suggestedFilename() !== "demo.pdf" || content !== "made") {
        throw new Error(
          `agent e2e: saved ${saved.suggestedFilename()}: ${content}`,
        );
      }
      await context.close();
    }

    // The model fails to start: the reason, and the button back.
    {
      const context = await browser.newContext();
      await withModel(context, { worker: "fail", webgpu: true });
      const page = await context.newPage();
      await page.goto(`${server.url}/?suspend=0#agent`);
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
    await page.goto(`${server.url}/?suspend=0#agent`);
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

    // A command of several lines is shown as one (yurt-playground#154):
    // on one line, a script reads as a single invalid command.
    await task.fill("print two lines");
    await task.press("Enter");
    await until(
      page,
      "the two-line command's answer",
      () =>
        [...document.querySelectorAll("[data-testid=agent-answer]")].at(-1)
          ?.textContent === "2",
      60_000,
    );
    const twoLines = await page.locator("#agent-transcript .call").last()
      .innerText();
    if (twoLines !== "$ echo 1\necho 2") {
      throw new Error(
        `agent e2e: a two-line command shows as ${JSON.stringify(twoLines)}`,
      );
    }

    // The sidebar shows one section at a time, and the terminal it hides keeps
    // its size: a shell resized to nothing would reflow, and report 0 columns.
    {
      const cols = () =>
        page.evaluate(() => document.querySelector("#term-wrap")?.clientWidth);
      await page.locator("[data-testid=view-shell]").click();
      const before = await cols();
      if (
        !before || !await page.locator("#term-wrap").isVisible() ||
        !await page.locator("#notebook").isVisible()
      ) {
        throw new Error("agent e2e: Shell & Python does not show both");
      }
      for (const link of ["choose-notebook", "choose-lab"]) {
        if (!await page.getByTestId(link).isVisible()) {
          throw new Error(`agent e2e: no ${link} in Shell & Python`);
        }
      }
      if (await page.locator("[data-testid=view-python]").count() !== 0) {
        throw new Error("agent e2e: Python still has a section of its own");
      }
      await page.locator("[data-testid=view-install]").click();
      if (
        await page.locator("#term-wrap").isVisible() ||
        await page.locator("#agent").isVisible() ||
        !await page.locator("#install").isVisible()
      ) {
        throw new Error("agent e2e: Install does not show alone");
      }
      if (await cols() !== before) {
        throw new Error(
          `agent e2e: the hidden terminal is ${await cols()} wide`,
        );
      }
      await page.locator("[data-testid=view-suspend]").click();
      if (!await page.locator("#snapshots h2").isVisible()) {
        throw new Error("agent e2e: Suspend does not show");
      }
      if (new URL(page.url()).hash !== "#suspend") {
        throw new Error(`agent e2e: the URL says ${page.url()}`);
      }
      await page.locator("[data-testid=view-agent]").click();
    }

    // Each button says whose it is: the agent's Run and Stop beside the
    // Python cell's (yurt-playground#154).
    for (
      const name of [
        "Run the agent",
        "Stop the agent",
        "Run the Python cell",
        "Stop the Python cell",
      ]
    ) {
      const count = await page.getByRole("button", {
        name,
        exact: true,
        includeHidden: true,
      }).count();
      if (count !== 1) {
        throw new Error(`agent e2e: ${count} buttons named "${name}"`);
      }
    }

    // Stop: the command dies, the transcript says so.
    await task.fill("sleep for a minute");
    await task.press("Enter");
    await until(
      page,
      "the sleep to start",
      () =>
        [...document.querySelectorAll("#agent-transcript .call")].at(-1)
          ?.textContent?.includes("sleep") === true,
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
