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
import { saveInBrowser, type Yurt } from "./agent_api.ts";
import { AGENT_CHAT_STORAGE } from "./snapshot_store.ts";
import {
  createAgentTools,
  sandboxHasPython,
  waitForSandbox,
} from "./agent_tools.ts";
import {
  type AgentEvent,
  chatTask,
  DEFAULT_LIMITS,
  DEMO_PDF_MADE,
  DEMO_PDF_PATH,
  DEMO_TASK,
  DEMO_TEXT_PATH,
  type Limits,
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

/** What a sealed sandbox's chat needs across the reload that resumes it. The
 * sandbox holds the document; this holds the conversation around it. */
type SavedChat = {
  choice: string;
  model: string;
  chat: string[];
  transcript: string;
  pdf?: string;
  /** The message that asked for the resume, to run once it has. */
  pending?: string;
};

function loadChat(): SavedChat | undefined {
  try {
    const saved = localStorage.getItem(AGENT_CHAT_STORAGE);
    return saved === null ? undefined : JSON.parse(saved);
  } catch {
    return undefined;
  }
}

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
    /** Seal the sandbox after each run; resolves to why it could not. Unset:
     * the sandbox keeps running. */
    suspend?: () => Promise<string | undefined>;
    /** Reload on purpose: not a boot the browser cut off. */
    reload?: () => void;
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
        "processes, the same as typing in its terminal. Every step is " +
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
  /** The chat so far: the visitor's messages, in order. */
  const chat: string[] = [];
  /** The latest PDF, read before the sandbox seals: it cannot be read after. */
  let lastPdf: Uint8Array | undefined;
  let suspended = false;
  const reloadPage = sandbox.reload ?? (() => location.reload());
  let modelLabel = "";

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
      modelLabel = `${installed.value} · Ollama · on this computer`;
      status.textContent = modelLabel;
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

  const startModel = async () => {
    if (choice.value === OLLAMA) return await connectOllama();
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
    modelLabel = `${model.label} · WebGPU · in this tab`;
    status.textContent = modelLabel;
    // Which runtime build the browser got, and whether the weights were
    // already cached (tests/agent_webgpu_e2e.ts reports both).
    root.dataset.agentRuntime = local.loaded.wasmVariant;
    root.dataset.agentFromCache = String(local.loaded.fromCache);
    ready();
  };
  startButton.addEventListener("click", () => void startModel());

  const showContext = () => {
    const used = llm?.lastStats?.promptTokens;
    if (used === undefined) return;
    context.hidden = false;
    context.textContent =
      `context ${used.toLocaleString()} / ${contextTokens.toLocaleString()} tokens`;
  };

  const removeDownload = () => {
    for (const old of transcript.querySelectorAll("li.download")) old.remove();
  };
  const offerDownload = () => {
    removeDownload();
    const bytes = lastPdf;
    if (bytes === undefined) return;
    const name = DEMO_PDF_PATH.split("/").pop()!;
    const download = el("button", {
      type: "button",
      className: "bar-action",
      textContent: `Download ${name}`,
      testid: "agent-download",
    });
    download.addEventListener("click", () => saveInBrowser(name, bytes));
    transcript.append(el("li", { className: "note download" }, download));
  };
  const saveChat = (pending?: string) => {
    removeDownload();
    const saved: SavedChat = {
      choice: choice.value,
      model: installed.value,
      chat,
      transcript: transcript.innerHTML,
      pdf: lastPdf === undefined
        ? undefined
        : btoa(String.fromCharCode(...lastPdf)),
      pending,
    };
    offerDownload();
    try {
      localStorage.setItem(AGENT_CHAT_STORAGE, JSON.stringify(saved));
    } catch {
      // The sandbox still resumes, without the conversation.
    }
  };
  /** After each run: the sandbox goes into browser storage, and the next
   * message or a reload brings it back (src/boot.ts). */
  const suspendNow = async () => {
    if (sandbox.suspend === undefined) return;
    status.textContent = "suspending";
    const why = await sandbox.suspend();
    suspended = true;
    if (why === undefined) {
      saveChat();
      status.textContent = `${modelLabel} · suspended`;
    } else {
      status.textContent = modelLabel;
      transcript.append(
        el("li", {
          className: "stopped",
          textContent: `Could not suspend: ${why}`,
        }),
      );
    }
    root.dataset.agentSuspended = "";
  };
  /** The next boot finds no chat, so it starts fresh and drops the seal. */
  const newSession = () => {
    try {
      localStorage.removeItem(AGENT_CHAT_STORAGE);
    } catch {
      // Nothing to remove, then.
    }
    reloadPage();
  };

  const go = async () => {
    const text = task.value.trim();
    if (llm === undefined || running !== undefined || text === "") return;
    if (suspended) {
      saveChat(text);
      reloadPage();
      return;
    }
    const controller = new AbortController();
    running = controller;
    run.disabled = true;
    installed.disabled = true;
    stop.hidden = false;
    transcript.append(
      el("li", { className: "user", testid: "agent-user", textContent: text }),
    );
    const earlier = chat.slice();
    chat.push(text);
    task.value = "";
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
      if (e.type === "repeat") {
        current?.item.remove();
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
        } else if (e.action.action === "set_color") {
          pdf = undefined;
          lastPdf = undefined;
          removeDownload();
          line = el(
            "div",
            { className: "call" },
            el("b", { textContent: "color " }),
            e.action.color,
          );
        } else if (e.action.action === "write_file") {
          // What is on offer is about to change; it comes back once it is made.
          pdf = undefined;
          lastPdf = undefined;
          removeDownload();
          line = el(
            "div",
            { className: "call" },
            el("b", { textContent: "write " }),
            e.action.path,
            el("pre", { className: "result", textContent: e.action.text }),
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
        // Offered only once the write has said it made the file.
        if (e.text.endsWith(DEMO_PDF_MADE)) pdf = DEMO_PDF_PATH;
        current?.item.append(
          el("pre", { className: "result", textContent: e.text }),
        );
        return;
      }
      if (e.type === "stopped" && e.reason === "task") {
        // Refused for its length: it stays in the box to shorten, out of the chat.
        chat.pop();
        task.value = text;
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
          repeat: "stopped: the model kept repeating the same step",
        }[e.reason];
        transcript.append(el("li", { className: "stopped", textContent: why }));
      }
    };
    const tools = createAgentTools(yurt);
    // The slim image has no python3; the prompt must not promise one.
    const python = await sandboxHasPython(tools, controller.signal);
    // None yet on the first message, and a failed read only loses the context.
    const document = await tools.readFile(DEMO_TEXT_PATH, controller.signal)
      .catch(() => undefined);
    await runAgent(
      chatTask(earlier, text, limits.maxTask, document),
      llm,
      tools,
      onEvent,
      controller.signal,
      limits,
      systemPrompt(python),
    );
    // However the task ended: a stop after the PDF was made still made it.
    if (pdf !== undefined) {
      lastPdf = await yurt.fs.read(pdf).catch(() => undefined);
    }
    offerDownload();
    stop.hidden = true;
    await suspendNow();
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
  // The terminal and the Python cell are this sandbox too: opening them resumes it.
  document.querySelector("[data-testid=view-shell]")?.addEventListener(
    "click",
    () => {
      if (suspended) reloadPage();
    },
  );

  if (sandbox.suspend === undefined) return;
  const fresh = el("button", {
    type: "button",
    className: "bar-action",
    textContent: "New session",
    testid: "agent-new-session",
  });
  fresh.addEventListener("click", newSession);
  run.parentElement?.append(fresh);

  // A reload, or the message that asked for one: back where the run ended.
  const saved = loadChat();
  if (saved === undefined) return;
  if (!Array.from(choice.options).some((o) => o.value === saved.choice)) return;
  chat.push(...saved.chat);
  transcript.innerHTML = saved.transcript;
  if (saved.pdf !== undefined) {
    lastPdf = Uint8Array.from(atob(saved.pdf), (c) => c.charCodeAt(0));
  }
  choice.value = saved.choice;
  await label();
  await startModel();
  if (llm === undefined) return;
  if (
    saved.model !== "" && installed.querySelector(`[value="${saved.model}"]`)
  ) {
    installed.value = saved.model;
    installed.dispatchEvent(new Event("change"));
  }
  offerDownload();
  if (saved.pending !== undefined) {
    saveChat();
    task.value = saved.pending;
    void go();
  } else {
    sandbox.start();
  }
}
