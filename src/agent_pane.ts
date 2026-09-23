/**
 * The home page's agent pane (#140): a language model running in this tab
 * on the GPU, using the page's own sandbox through window.yurt. One action
 * to download and start, then a task box; every step the controller
 * (src/agent.ts) takes is shown as it happens. The pane only appears where
 * the server has a model to give (`/llm/models.json`), so the hosted site,
 * which has none, is unchanged.
 */
import type { Yurt } from "./agent_api.ts";
import { type AgentEvent, runAgent, type Tools } from "./agent.ts";
import { loadLocalModel, type LocalLlm } from "./llm.ts";
import { LOCAL_MODELS, type LocalModel, MAX_NUM_TOKENS } from "./llm_models.ts";

const CACHE = "yurt-llm";
const GiB = 2 ** 30;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { testid?: string } = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  const { testid, ...rest } = props;
  Object.assign(node, rest);
  if (testid !== undefined) node.dataset.testid = testid;
  node.append(...children);
  return node;
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

async function isCached(model: LocalModel): Promise<boolean> {
  try {
    const cache = await caches.open(CACHE);
    return await cache.match(`/llm/${model.file}?sha256=${model.sha256}`) !==
      undefined;
  } catch {
    return false;
  }
}

/** Which pinned models this server offers; none (a 404) hides the pane. */
async function offeredModels(): Promise<LocalModel[]> {
  try {
    const response = await fetch("/llm/models.json");
    if (!response.ok) return [];
    const ids: string[] = await response.json();
    return LOCAL_MODELS.filter((m) => ids.includes(m.id));
  } catch {
    return [];
  }
}

function sandboxTools(yurt: Yurt): Tools {
  return {
    async exec(cmd, signal) {
      const execution = await yurt.spawn(cmd, { timeoutMs: 30_000 });
      const kill = () => void execution.kill().catch(() => {});
      signal.addEventListener("abort", kill, { once: true });
      try {
        const r = await execution.wait();
        return {
          code: "code" in r ? r.code : null,
          stdout: r.stdout,
          stderr: r.stderr,
        };
      } finally {
        signal.removeEventListener("abort", kill);
      }
    },
    async readFile(path) {
      return new TextDecoder().decode(await yurt.fs.read(path));
    },
  };
}

export async function mountAgentPane(
  root: HTMLElement,
  sandbox: { yurt: () => Yurt; start: () => void },
): Promise<void> {
  const models = await offeredModels();
  if (models.length === 0 || !("gpu" in navigator)) return;
  root.hidden = false;

  // The bar: what this is, the model's state, the context in use, Stop.
  const status = el("span", {
    id: "agent-status",
    testid: "agent-status",
    textContent: "not loaded",
  });
  const context = el("span", { id: "agent-context", hidden: true });
  const stop = el("button", {
    type: "button",
    className: "bar-action",
    textContent: "Stop",
    hidden: true,
    testid: "agent-stop",
  });
  const bar = el(
    "div",
    { className: "bar" },
    el("span", { className: "name", textContent: "Agent" }),
    status,
    el("span", { className: "grow" }),
    context,
    stop,
  );

  // Before the model: what it is, the choice, the one action.
  const choice = el("select", {
    id: "agent-model",
    testid: "agent-model",
  });
  choice.setAttribute("aria-label", "Model");
  for (const m of models) {
    const hint = m.id === "E4B" ? "more reliable" : "about twice as fast";
    choice.append(
      el("option", {
        value: m.id,
        textContent: `${m.label} · ${(m.bytes / GiB).toFixed(1)} GiB · ${hint}`,
      }),
    );
  }
  const startButton = el("button", {
    type: "button",
    id: "agent-start",
    testid: "agent-start",
  });
  const progress = el("progress", { hidden: true, max: 1, value: 0 });
  const intro = el(
    "div",
    { id: "agent-intro" },
    el(
      "p",
      {},
      "A language model that runs in this tab, on your GPU, and works in the " +
        "sandbox the way a program would: it runs commands and reads files " +
        "through ",
      el("code", { textContent: "window.yurt" }),
      ", one checked step at a time. Nothing is sent anywhere; once it is " +
        "downloaded it works offline.",
    ),
    el("div", { className: "row" }, choice, startButton),
    progress,
  );
  const selected = () => models.find((m) => m.id === choice.value)!;
  const label = async () => {
    const m = selected();
    startButton.textContent = await isCached(m)
      ? `Start ${m.label}`
      : `Download ${m.label} (${(m.bytes / GiB).toFixed(1)} GiB) and start`;
  };
  choice.addEventListener("change", () => void label());
  await label();

  // After the model: the task, Run, and the transcript.
  const task = el("textarea", {
    id: "agent-task",
    value: "How many lines does /etc/passwd have?",
    testid: "agent-task",
  });
  task.setAttribute("aria-label", "Task for the agent");
  const run = el("button", {
    type: "button",
    id: "agent-run",
    textContent: "Run",
    testid: "agent-run",
  });
  const hint = el("span", {
    className: "hint",
    textContent: "Enter to run · Shift+Enter for a new line",
  });
  const transcript = el("ol", {
    id: "agent-transcript",
    testid: "agent-transcript",
  });
  const work = el(
    "div",
    { hidden: true },
    task,
    el("div", { className: "actions" }, run, hint),
    transcript,
  );
  root.replaceChildren(bar, intro, work);

  let llm: LocalLlm | undefined;
  let running: AbortController | undefined;

  startButton.addEventListener("click", async () => {
    const model = selected();
    startButton.disabled = true;
    choice.disabled = true;
    progress.hidden = false;
    progress.removeAttribute("value");
    status.textContent = "starting";
    try {
      llm = await loadLocalModel(model, (p) => {
        if (p.phase === "download") {
          progress.value = p.loaded / p.total;
          status.textContent = `downloading ${(p.loaded / GiB).toFixed(2)} / ${
            (p.total / GiB).toFixed(2)
          } GiB`;
        } else {
          progress.removeAttribute("value");
          status.textContent = "starting on the GPU";
        }
      });
    } catch (error) {
      status.textContent = `failed: ${
        error instanceof Error ? error.message : error
      }`;
      startButton.disabled = false;
      choice.disabled = false;
      progress.hidden = true;
      return;
    }
    status.textContent = `${model.label} · WebGPU · in this tab`;
    root.dataset.agentReady = "";
    intro.hidden = true;
    work.hidden = false;
    task.focus();
  });

  const showContext = () => {
    const used = llm?.lastStats?.promptTokens;
    if (used === undefined) return;
    context.hidden = false;
    context.textContent =
      `context ${used.toLocaleString()} / ${MAX_NUM_TOKENS.toLocaleString()} tokens`;
  };

  const go = async () => {
    const text = task.value.trim();
    if (llm === undefined || running !== undefined || text === "") return;
    running = new AbortController();
    run.disabled = true;
    stop.hidden = false;
    transcript.replaceChildren();
    const yurt = sandbox.yurt();
    if (yurt.status !== "running") {
      const waiting = el("li", {
        className: "note",
        textContent: "starting the sandbox first",
      });
      transcript.append(waiting);
      if (yurt.status === "idle") sandbox.start();
      try {
        await yurt.ready;
      } catch (error) {
        waiting.className = "stopped";
        waiting.textContent = `the sandbox did not start: ${error}`;
        finish();
        return;
      }
      waiting.remove();
    }
    let current: { item: HTMLLIElement; live: HTMLElement } | undefined;
    llm.onToken = (t) => {
      if (current) current.live.textContent += t;
    };
    const onEvent = (e: AgentEvent) => {
      if (e.type === "step") {
        const live = el("pre", { className: "live" });
        const item = el("li", { className: "step" }, live);
        transcript.append(item);
        current = { item, live };
        return;
      }
      if (e.type === "action" || e.type === "invalid") {
        showContext();
        const meta = el("span", {
          className: "meta",
          textContent: `${seconds(e.ms)} · ${e.stats.outputTokens} tokens`,
        });
        let line: HTMLElement;
        if (e.type === "invalid") {
          line = el("div", { className: "invalid" }, "not an action: ", e.raw);
        } else if (e.action.action === "exec") {
          line = el(
            "div",
            { className: "call" },
            el("b", { textContent: "$ " }),
            e.action.cmd,
          );
        } else if (e.action.action === "read_file") {
          line = el(
            "div",
            { className: "call" },
            el("b", { textContent: "read " }),
            e.action.path,
          );
        } else {
          line = el(
            "div",
            { className: "answer", testid: "agent-answer" },
            e.action.text,
          );
        }
        current?.live.replaceWith(el("div", { className: "head" }, line, meta));
        return;
      }
      if (e.type === "observation") {
        current?.item.append(
          el("pre", { className: "result", textContent: e.text }),
        );
        return;
      }
      if (e.type === "stopped" || e.type === "error") {
        current?.live.remove();
        const why = e.type === "error" ? e.message : {
          cancelled: "stopped",
          steps: "stopped: too many steps without an answer",
          invalid:
            "stopped: the model kept replying with something that is not an action",
          timeout: "stopped: the task took too long",
        }[e.reason];
        transcript.append(el("li", { className: "stopped", textContent: why }));
      }
    };
    await runAgent(text, llm, sandboxTools(yurt), onEvent, running.signal);
    finish();
  };
  const finish = () => {
    running = undefined;
    run.disabled = false;
    stop.hidden = true;
  };
  run.addEventListener("click", () => void go());
  task.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void go();
    }
  });
  stop.addEventListener("click", () => running?.abort());
}
