/**
 * The home page's agent pane (#140): a language model running in this tab
 * on the GPU, using the page's own sandbox through window.yurt. One action
 * to download and start, then a task box; every step the controller
 * (src/agent.ts) takes is shown as it happens. The pane appears where the
 * site ships the inference runtime (`/llm/models.json`, written by the
 * static build and answered by the dev server); the weights download from
 * Hugging Face (src/llm_models.ts). The other choice is a model the visitor
 * already runs with Ollama on this computer (src/ollama.ts), which needs no
 * WebGPU and no download; the page does not contact it until asked to.
 */
import type { Yurt } from "./agent_api.ts";
import {
  createAgentTools,
  sandboxHasPython,
  waitForSandbox,
} from "./agent_tools.ts";
import {
  type AgentEvent,
  DEFAULT_LIMITS,
  DEMO_TASK,
  type Limits,
  mkpdfOutput,
  type Model,
  type ModelStats,
  runAgent,
  systemPrompt,
} from "./agent.ts";
import { isModelCached, loadLocalModel } from "./llm.ts";
import { LOCAL_MODELS, type LocalModel, MAX_NUM_TOKENS } from "./llm_models.ts";
import {
  listOllamaModels,
  OLLAMA_CONTEXT_TOKENS,
  OLLAMA_LIMITS,
  ollamaHelp,
  ollamaModel,
} from "./ollama.ts";

const GiB = 2 ** 30;

/** The model choice that is not a pinned download. */
const OLLAMA = "ollama";

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

/** Which pinned models this site offers; none (a 404) hides the pane. */
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

export async function mountAgentPane(
  root: HTMLElement,
  sandbox: {
    yurt: () => Yurt;
    start: () => void;
    /** Set when the page will not start a sandbox (a phone, a boot the
     * browser cut off): the pane says why, in the status like the Python
     * cell's, and offers neither the download nor a Run (#197). */
    unavailable?: string;
  },
): Promise<void> {
  const models = await offeredModels();
  if (models.length === 0) return;
  root.hidden = false;
  if (sandbox.unavailable !== undefined) {
    root.replaceChildren(
      el(
        "div",
        { className: "bar" },
        el("span", { className: "name", textContent: "Agent" }),
        el("span", {
          id: "agent-status",
          testid: "agent-status",
          textContent: sandbox.unavailable,
        }),
      ),
      el(
        "div",
        { id: "agent-intro" },
        el(
          "p",
          { className: "unsupported", testid: "agent-unavailable" },
          "The agent works in this page's sandbox, and the sandbox does not " +
            "start here.",
        ),
      ),
    );
    return;
  }
  const gpu = (navigator as Navigator & { gpu?: GPU }).gpu;
  const adapter = await gpu?.requestAdapter().catch(() => null);

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
  // The Python cell has a Run and a Stop of its own on the same page.
  stop.setAttribute("aria-label", "Stop the agent");
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
  for (const m of adapter ? models : []) {
    choice.append(el("option", { value: m.id, textContent: m.choice }));
  }
  choice.append(
    el("option", {
      value: OLLAMA,
      textContent: "On this computer, with Ollama",
    }),
  );
  const startButton = el("button", {
    type: "button",
    id: "agent-start",
    testid: "agent-start",
  });
  const progress = el("progress", { hidden: true, max: 1, value: 0 });
  const cost = el("p", { className: "cost", testid: "agent-cost" });
  // What it is, what it may do, and what it costs, before anything loads.
  const intro = el(
    "div",
    { id: "agent-intro" },
    el(
      "p",
      {},
      adapter
        ? "A language model that runs in this tab, on your GPU. Its weights " +
          "download once from Hugging Face; after that nothing you type is " +
          "sent anywhere. It works in this page's sandbox through "
        : "A language model from Ollama on this computer: nothing is " +
          "downloaded, and what you type stays on this computer. It works in " +
          "this page's sandbox through ",
      el("code", { textContent: "window.yurt" }),
      " and can run any command there, change or delete files and stop " +
        "processes, the same as typing in the terminal above. Every step is " +
        "shown as it runs, and Stop ends it." +
        (adapter
          ? " Or use a model you already run with Ollama on this computer: " +
            "nothing is downloaded, and what you type stays on this computer."
          : ""),
    ),
    el("div", { className: "row" }, choice, startButton),
    cost,
    progress,
  );
  if (!adapter) {
    intro.prepend(
      el(
        "p",
        { className: "unsupported", testid: "agent-unsupported" },
        "This browser offers no WebGPU, which a model needs to run in the " +
          "tab. A current Chrome, Edge or Safari on a desktop has it. A " +
          "model in Ollama on this computer does not need it.",
      ),
    );
  }
  const selected = () => models.find((m) => m.id === choice.value)!;
  const label = async () => {
    if (choice.value === OLLAMA) {
      startButton.textContent = "Connect to Ollama";
      cost.textContent = "Ollama must be running, with a model installed. " +
        "The browser may ask whether this site may reach your local network.";
      return;
    }
    const m = selected();
    const cached = await isModelCached(m);
    startButton.textContent = cached
      ? `Start ${m.label}`
      : `Download ${m.label} (${(m.bytes / GiB).toFixed(1)} GiB) and start`;
    cost.textContent =
      `Needs about ${m.memoryGB} GB of free memory while it runs. ` +
      (cached
        ? "Already downloaded."
        : "Downloaded from Hugging Face; the browser keeps it for next time.");
  };
  choice.addEventListener("change", () => void label());
  await label();

  // After the model: the task, Run, and the transcript.
  const installed = el("select", {
    id: "agent-installed",
    testid: "agent-installed",
    hidden: true,
  });
  installed.setAttribute("aria-label", "Ollama model");
  const task = el("textarea", {
    id: "agent-task",
    value: DEMO_TASK,
    testid: "agent-task",
  });
  task.setAttribute("aria-label", "Task for the agent");
  const run = el("button", {
    type: "button",
    id: "agent-run",
    textContent: "Run",
    testid: "agent-run",
  });
  run.setAttribute("aria-label", "Run the agent");
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
    installed,
    task,
    el("div", { className: "actions" }, run, hint),
    transcript,
  );
  root.replaceChildren(bar, intro, work);

  let llm:
    | (Model & { lastStats?: ModelStats; onToken?: (t: string) => void })
    | undefined;
  let contextTokens = MAX_NUM_TOKENS;
  let limits: Limits = DEFAULT_LIMITS;
  let running: AbortController | undefined;

  const ready = () => {
    root.dataset.agentReady = "";
    intro.hidden = true;
    work.hidden = false;
    task.focus();
  };

  /** Only here, on the visitor's click, does the page contact Ollama. */
  const connectOllama = async () => {
    startButton.disabled = true;
    choice.disabled = true;
    status.textContent = "connecting";
    let names: string[] | undefined;
    try {
      names = await listOllamaModels();
    } catch {
      cost.textContent = ollamaHelp(location.origin);
    }
    if (names?.length === 0) {
      cost.textContent =
        "Ollama has no models yet. Install one, for example: ollama pull gemma4:e4b";
    }
    if (names === undefined || names.length === 0) {
      status.textContent = "not connected";
      startButton.disabled = false;
      choice.disabled = false;
      return;
    }
    const showModel = () => {
      status.textContent = `${installed.value} · Ollama · on this computer`;
    };
    installed.replaceChildren(
      ...names.map((name) => el("option", { value: name, textContent: name })),
    );
    installed.hidden = false;
    installed.addEventListener("change", showModel);
    showModel();
    llm = ollamaModel(() => installed.value);
    contextTokens = OLLAMA_CONTEXT_TOKENS;
    limits = OLLAMA_LIMITS;
    ready();
  };

  startButton.addEventListener("click", async () => {
    if (choice.value === OLLAMA) return connectOllama();
    const model = selected();
    startButton.disabled = true;
    choice.disabled = true;
    progress.hidden = false;
    progress.removeAttribute("value");
    status.textContent = "starting";
    let local: Awaited<ReturnType<typeof loadLocalModel>>;
    try {
      local = await loadLocalModel(model, (p) => {
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
    llm = local;
    status.textContent = `${model.label} · WebGPU · in this tab`;
    // Which runtime build the browser got, and whether the weights were
    // already cached (tests/agent_webgpu_e2e.ts reports both).
    root.dataset.agentRuntime = local.loaded.wasmVariant;
    root.dataset.agentFromCache = String(local.loaded.fromCache);
    ready();
  });

  const showContext = () => {
    const used = llm?.lastStats?.promptTokens;
    if (used === undefined) return;
    context.hidden = false;
    context.textContent =
      `context ${used.toLocaleString()} / ${contextTokens.toLocaleString()} tokens`;
  };

  const go = async () => {
    const text = task.value.trim();
    if (llm === undefined || running !== undefined || text === "") return;
    const controller = new AbortController();
    running = controller;
    run.disabled = true;
    installed.disabled = true;
    stop.hidden = false;
    transcript.replaceChildren();
    const yurt = sandbox.yurt();
    if (yurt.status !== "running") {
      const waiting = el("li", {
        className: "note",
        textContent: "starting the sandbox first",
      });
      transcript.append(waiting);
      try {
        await waitForSandbox(yurt, sandbox.start, controller.signal);
      } catch (error) {
        if (controller.signal.aborted) {
          waiting.textContent = "stopped";
          waiting.className = "stopped";
          finish();
          return;
        }
        waiting.className = "stopped";
        waiting.textContent = `the sandbox did not start: ${error}`;
        finish();
        return;
      }
      waiting.remove();
    }
    let current: { item: HTMLLIElement; live: HTMLElement } | undefined;
    let pdf: string | undefined;
    let pdfRunning: string | undefined;
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
          pdfRunning = mkpdfOutput(e.action.cmd);
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
        // Offered only once the command has said it worked.
        if (pdfRunning !== undefined && e.text.startsWith("exit 0\n")) {
          pdf = pdfRunning;
        }
        pdfRunning = undefined;
        current?.item.append(
          el("pre", { className: "result", textContent: e.text }),
        );
        return;
      }
      if (e.type === "answer" && pdf !== undefined) {
        const path = pdf;
        const download = el("button", {
          type: "button",
          className: "bar-action",
          textContent: `Download ${path.split("/").pop()}`,
          testid: "agent-download",
        });
        download.addEventListener("click", () => {
          yurt.fs.download(path).catch((error) => {
            download.textContent = `Could not download: ${error}`;
          });
        });
        transcript.append(el("li", { className: "note" }, download));
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
          task: "not started: the task is too long; shorten it",
        }[e.reason];
        transcript.append(el("li", { className: "stopped", textContent: why }));
      }
    };
    const tools = createAgentTools(yurt);
    // The slim image has no python3; the prompt must not promise one.
    const python = await sandboxHasPython(tools, controller.signal);
    await runAgent(
      text,
      llm,
      tools,
      onEvent,
      controller.signal,
      limits,
      systemPrompt(python),
    );
    finish();
  };
  const finish = () => {
    running = undefined;
    run.disabled = false;
    installed.disabled = false;
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
