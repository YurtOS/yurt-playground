/**
 * The home page's agent pane (#140): a language model running in this tab
 * on the GPU, using the page's own sandbox through window.yurt. One action
 * to download and start, then a task box; every step the controller
 * (src/agent.ts) takes is shown as it happens. The pane appears where the
 * site ships the inference runtime (`/llm/models.json`, written by the
 * static build and answered by the dev server); the weights download from
 * Hugging Face (src/llm_models.ts). A browser without WebGPU is told so.
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
  DEMO_TASK,
  DEMO_TEXT_PATH,
  demoTextRedirect,
  type Limits,
  madePdfPath,
  type Model,
  type ModelStats,
  runAgent,
  systemPrompt,
} from "./agent.ts";
import { isModelCached, loadLocalModel } from "./llm.ts";
import {
  finishOpenrouterSignIn,
  openrouterKey,
  openrouterModel,
  openrouterModels,
  type RemoteModel,
  setOpenrouterKey,
  signInWithOpenrouter,
} from "./openrouter.ts";
import { LOCAL_MODELS, type LocalModel, MAX_NUM_TOKENS } from "./llm_models.ts";

const GiB = 2 ** 30;

/** What a sealed sandbox's chat needs across the reload that resumes it. The
 * sandbox holds the document; this holds the conversation around it. */
type SavedChat = {
  choice: string;
  chat: string[];
  transcript: string;
  /** Path to base64: the PDFs on offer. */
  pdfs?: Record<string, string>;
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
    /** Whether this load is the page's own reload, resuming a run: only then
     * does the saved model start without a click (a new visit with a saved
     * chat must not download or load weights by itself). */
    resumeRun?: () => boolean;
    /** Offer only models that run outside this tab (a tablet: no GPU
     * model fits beside the sandbox). */
    remoteOnly?: boolean;
  },
): Promise<void> {
  const signInError = await finishOpenrouterSignIn();
  // `?model=openrouter:<id>` picks any OpenRouter model.
  const wanted = new URLSearchParams(location.search).get("model");
  const orModels: RemoteModel[] = openrouterModels(
    wanted?.startsWith("openrouter:")
      ? wanted.slice("openrouter:".length)
      : undefined,
  );
  let models = sandbox.remoteOnly ? [] : await offeredModels();
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
  // A model in this tab needs WebGPU; without it only remote ones remain.
  if (models.length > 0) {
    const gpu = (navigator as Navigator & { gpu?: GPU }).gpu;
    const adapter = await gpu?.requestAdapter().catch(() => null);
    if (!adapter) models = [];
  }

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
  for (const m of [...models, ...orModels]) {
    choice.append(el("option", { value: m.id, textContent: m.choice }));
  }
  const startButton = el("button", {
    type: "button",
    id: "agent-start",
    testid: "agent-start",
  });
  const progress = el("progress", { hidden: true, max: 1, value: 0 });
  const keyInput = el("input", {
    type: "password",
    placeholder: "or paste an OpenRouter key (sk-or-…)",
    hidden: true,
  });
  keyInput.setAttribute("aria-label", "OpenRouter key");
  const signOut = el("button", {
    type: "button",
    textContent: "Sign out of OpenRouter",
    hidden: true,
  });
  const cost = el("p", { className: "cost", testid: "agent-cost" });
  // What it is, what it may do, and what it costs, before anything loads.
  const intro = el(
    "div",
    { id: "agent-intro" },
    el(
      "p",
      {},
      models.length === 0
        ? "A language model that runs outside this tab: on OpenRouter with " +
          "your own account. It works in this page's sandbox through "
        : "A language model that runs in this tab, on your GPU. Its weights " +
          "download once from Hugging Face; after that nothing you type is " +
          "sent anywhere. It works in this page's sandbox through ",
      el("code", { textContent: "window.yurt" }),
      " and can run any command there, change or delete files and stop " +
        "processes, the same as typing in its terminal. Every step is " +
        "shown as it runs, and Stop ends it.",
    ),
    el("div", { className: "row" }, choice, startButton),
    keyInput,
    cost,
    signOut,
    progress,
  );
  const selected = () => models.find((m) => m.id === choice.value)!;
  const selectedOr = (): RemoteModel | undefined =>
    orModels.find((m) => m.id === choice.value);
  const label = async () => {
    const o = selectedOr();
    keyInput.hidden = true;
    signOut.hidden = true;
    if (o !== undefined) {
      const signedIn = openrouterKey() !== undefined;
      startButton.textContent = signedIn
        ? `Start ${o.label}`
        : "Sign in with OpenRouter";
      keyInput.hidden = signedIn;
      signOut.hidden = !signedIn;
      cost.textContent = "Runs on OpenRouter with your account: your task " +
        "and the sandbox's output go to OpenRouter and the model's " +
        "provider. Your key stays in this browser.";
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
  signOut.addEventListener("click", () => {
    setOpenrouterKey(undefined);
    void label();
  });
  if (wanted !== null) {
    if (orModels.some((m) => m.id === wanted)) choice.value = wanted;
  }
  await label();
  if (signInError !== undefined) cost.textContent = signInError;

  // After the model: the task, Run, and the transcript.
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
    task,
    el("div", { className: "actions" }, run, hint),
    transcript,
  );
  root.replaceChildren(bar, intro, work);

  // New output stays in view, unless the visitor has scrolled up to read.
  let followTranscript = true;
  transcript.addEventListener("scroll", () => {
    followTranscript = transcript.scrollHeight - transcript.scrollTop -
        transcript.clientHeight < 40;
  });
  new MutationObserver(() => {
    if (followTranscript) transcript.scrollTop = transcript.scrollHeight;
  }).observe(transcript, {
    childList: true,
    subtree: true,
    characterData: true,
  });

  let llm:
    | (Model & { lastStats?: ModelStats; onToken?: (t: string) => void })
    | undefined;
  const contextTokens = MAX_NUM_TOKENS;
  const limits: Limits = DEFAULT_LIMITS;
  let running: AbortController | undefined;
  /** The chat so far: the visitor's messages, in order. */
  const chat: string[] = [];
  /** The PDFs on offer, read before the sandbox seals: they cannot be after. */
  const pdfs = new Map<string, Uint8Array>();
  let suspended = false;
  const reloadPage = sandbox.reload ?? (() => location.reload());
  let modelLabel = "";

  const ready = () => {
    root.dataset.agentReady = "";
    intro.hidden = true;
    work.hidden = false;
    task.focus();
  };

  const startModel = async () => {
    const o = selectedOr();
    if (o !== undefined) {
      if (openrouterKey() === undefined) {
        const pasted = keyInput.value.trim();
        if (pasted === "") {
          await signInWithOpenrouter();
          return;
        }
        setOpenrouterKey(pasted);
        keyInput.value = "";
      }
      llm = openrouterModel(o.openrouter!);
      modelLabel = o.label;
      status.textContent = modelLabel;
      signOut.hidden = true;
      ready();
      return;
    }
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
    if (pdfs.size === 0) return;
    const item = el("li", { className: "note download" });
    for (const [path, bytes] of pdfs) {
      const name = path.split("/").pop()!;
      const download = el("button", {
        type: "button",
        className: "bar-action",
        textContent: `Download ${name}`,
        testid: "agent-download",
      });
      download.dataset.file = name;
      download.addEventListener("click", () => saveInBrowser(name, bytes));
      item.append(download);
    }
    transcript.append(item);
  };
  const saveChat = (pending?: string) => {
    removeDownload();
    const saved: SavedChat = {
      choice: choice.value,
      chat,
      transcript: transcript.innerHTML,
      pdfs: Object.fromEntries(
        [...pdfs].map((
          [path, bytes],
        ) => [path, btoa(String.fromCharCode(...bytes))]),
      ),
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
      // The seal may have stopped the sandbox and stored nothing: the next
      // message starts a new one, so the chat and its PDFs start over too
      // rather than describing files that will not be there.
      status.textContent = modelLabel;
      chat.length = 0;
      pdfs.clear();
      transcript.append(
        el("li", {
          className: "stopped",
          textContent:
            `Could not save this session (${why}). The next message starts a new sandbox.`,
        }),
      );
      saveChat();
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
    // src/page.ts does not reload for a sidebar click meanwhile.
    root.dataset.agentBusy = "";
    run.disabled = true;
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
    const made = new Set<string>();
    llm.onToken = (t) => {
      if (current) current.live.textContent += t;
    };
    // This message's numbers, for the line that ends it.
    const started = performance.now();
    let modelCalls = 0;
    let agentCalls = 0;
    const onEvent = (e: AgentEvent) => {
      // Each step handed to the sandbox, whether or not it worked.
      if (e.type === "action" && e.action.action !== "answer") agentCalls++;
      if (e.type === "step") {
        modelCalls++;
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
          if (demoTextRedirect(e.action.cmd) !== undefined) removeDownload();
          line = el(
            "div",
            { className: "call" },
            el("b", { textContent: "$ " }),
            e.action.cmd,
          );
        } else if (e.action.action === "set_color") {
          // The PDF on disk stays as it was until it is remade (then read
          // again below), so its Download stays meanwhile.
          removeDownload();
          line = el(
            "div",
            { className: "call" },
            el("b", { textContent: "color " }),
            e.action.color,
          );
        } else if (e.action.action === "write_file") {
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
        const pdf = madePdfPath(e.text);
        if (pdf !== undefined) made.add(pdf);
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
    const times = (n: number) => `${n} ${n === 1 ? "time" : "times"}`;
    transcript.append(
      el("li", {
        className: "note stats",
        testid: "agent-stats",
        textContent: `agent called ${times(agentCalls)} · model called ${
          times(modelCalls)
        } · ${seconds(performance.now() - started)}`,
      }),
    );
    // However the task ended: a stop after the PDF was made still made it.
    for (const path of made) {
      const bytes = await yurt.fs.read(path).catch(() => undefined);
      if (bytes !== undefined) pdfs.set(path, bytes);
    }
    offerDownload();
    stop.hidden = true;
    await suspendNow();
    finish();
  };
  const finish = () => {
    running = undefined;
    delete root.dataset.agentBusy;
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
  // Only at the Agent tab: the Shell tab has a sandbox of its own to start.
  const saved = location.hash === "#agent" ? loadChat() : undefined;
  if (saved === undefined) return;
  if (!Array.from(choice.options).some((o) => o.value === saved.choice)) return;
  chat.push(...saved.chat);
  transcript.innerHTML = saved.transcript;
  for (const [path, encoded] of Object.entries(saved.pdfs ?? {})) {
    pdfs.set(path, Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0)));
  }
  choice.value = saved.choice;
  await label();
  if (!(sandbox.resumeRun?.() ?? true)) {
    offerDownload();
    return;
  }
  await startModel();
  if (llm === undefined) return;
  offerDownload();
  if (saved.pending !== undefined) {
    saveChat();
    task.value = saved.pending;
    void go();
  } else {
    sandbox.start();
  }
}
