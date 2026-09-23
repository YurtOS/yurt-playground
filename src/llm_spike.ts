/**
 * The #140 feasibility spike (public/llm-spike.html): can a quantized Gemma
 * run through WebGPU beside a running Yurt sandbox, emit a closed action
 * schema reliably, and keep working offline? Disposable: it measures, it is
 * not the demo. Every step is on `globalThis.llmSpike` so
 * tests/llm_spike_probe.ts can drive the same code the buttons do.
 */
import { attachGuestWorkerFactory } from "./page_worker_bridge.ts";
import { createYurt, type Yurt, type YurtTransport } from "./agent_api.ts";
import type { ExecOptions } from "./executions.ts";
import type { Tool } from "@litert-lm/core";
import type { Bench, FromWorker, ToWorker } from "./llm_worker.ts";

export const MODELS = {
  E2B: "/llm/gemma-4-E2B-it-web.litertlm",
  E4B: "/llm/gemma-4-E4B-it-web.litertlm",
} as const;
type ModelName = keyof typeof MODELS;

/** The active-context budget the engine is created with (prompt + output). */
const MAX_NUM_TOKENS = 4096;

// ---------------------------------------------------------------- actions

export type Action =
  | { action: "exec"; cmd: string }
  | { action: "read_file"; path: string }
  | { action: "answer"; text: string };

const ACTION_SYSTEM = [
  "You operate a Linux sandbox for the user.",
  "Reply with exactly one JSON object and nothing else. It must be one of:",
  '{"action":"exec","cmd":"<shell command>"}',
  '{"action":"read_file","path":"<absolute path>"}',
  '{"action":"answer","text":"<final answer>"}',
  "Use exec or read_file when you need facts from the sandbox; answer when you know.",
].join("\n");

const TOOL_SYSTEM =
  "You operate a Linux sandbox for the user. Call exactly one tool.";

const tool = (name: string, description: string, arg: string): Tool => ({
  type: "function",
  function: {
    name,
    description,
    parameters: {
      type: "object",
      properties: { [arg]: { type: "string" } },
      required: [arg],
    },
  },
});

const TOOLS: Tool[] = [
  tool("exec", "Run a shell command in the sandbox.", "cmd"),
  tool("read_file", "Read a file from the sandbox.", "path"),
  tool("answer", "Give the final answer to the user.", "text"),
];

/** Validate against the closed schema: exactly the keys of one variant,
 * each a non-empty string. Anything else is not an action. */
export function validateAction(value: unknown): Action | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  const field = { exec: "cmd", read_file: "path", answer: "text" }[
    v.action as string
  ];
  if (field === undefined) return null;
  const keys = Object.keys(v).sort();
  if (keys.length !== 2 || !keys.includes(field)) return null;
  if (typeof v[field] !== "string" || (v[field] as string).trim() === "") {
    return null;
  }
  return v as Action;
}

/** Strict: the reply is the object. Lenient: one fenced or surrounded
 * object. The spike reports both so the gap is visible. */
export function parseAction(
  text: string,
): { strict: Action | null; lenient: Action | null } {
  const tryParse = (s: string) => {
    try {
      return validateAction(JSON.parse(s));
    } catch {
      return null;
    }
  };
  const strict = tryParse(text.trim());
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  const lenient = strict ??
    (start >= 0 && end > start ? tryParse(text.slice(start, end + 1)) : null);
  return { strict, lenient };
}

/** Fixed tasks and the actions a sensible agent would take for each. */
export const ACTION_TASKS: { prompt: string; expect: Action["action"][] }[] = [
  {
    prompt: "How many lines are in /etc/passwd?",
    expect: ["exec", "read_file"],
  },
  {
    prompt: "Show me the contents of /etc/hostname.",
    expect: ["read_file", "exec"],
  },
  { prompt: "List the files in /usr/bin.", expect: ["exec"] },
  { prompt: "Which Python version is installed?", expect: ["exec"] },
  {
    prompt: "Find every file under /etc that mentions 'root'.",
    expect: ["exec"],
  },
  { prompt: "What does /proc/version say?", expect: ["read_file", "exec"] },
  { prompt: "What is the capital of France?", expect: ["answer"] },
  { prompt: "Say hello.", expect: ["answer"] },
];

// ------------------------------------------------------------- map step

/** A deterministic service log with known ERROR lines: the shape of one
 * map partition in the real demo. */
export function syntheticLog(lines: number, seed = 7) {
  let s = seed;
  const rand = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
  const services = ["auth", "db", "cache", "api", "queue"];
  const infos = [
    "request served in 12ms",
    "cache warm",
    "heartbeat ok",
    "connection pooled",
    "flushed 32 records",
  ];
  const errors = [
    "connection refused by upstream",
    "disk quota exceeded",
    "timeout waiting for lock",
    "invalid token signature",
  ];
  const out: string[] = [];
  const expected: { line: number; service: string; message: string }[] = [];
  for (let i = 1; i <= lines; i++) {
    const service = services[Math.floor(rand() * services.length)];
    if (rand() < 0.06) {
      const message = errors[Math.floor(rand() * errors.length)];
      expected.push({ line: i, service, message });
      out.push(`${i} ERROR [${service}] ${message}`);
    } else {
      out.push(
        `${i} INFO [${service}] ${infos[Math.floor(rand() * infos.length)]}`,
      );
    }
  }
  return { text: out.join("\n"), expected };
}

const MAP_SYSTEM = [
  "You extract facts from a log chunk.",
  'Reply with exactly one JSON object: {"errors":[{"line":<number>,"service":"<name>"}]}',
  "List every ERROR line and nothing else.",
].join("\n");

export function scoreMap(
  text: string,
  expected: { line: number; service: string }[],
) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  let got: { line: number; service: string }[] | null = null;
  try {
    const value = JSON.parse(text.slice(start, end + 1));
    if (Array.isArray(value?.errors)) got = value.errors;
  } catch {
    got = null;
  }
  if (got === null) return { valid: false, precision: 0, recall: 0 };
  const want = new Set(expected.map((e) => `${e.line}|${e.service}`));
  const have = new Set(got.map((e) => `${e.line}|${e.service}`));
  const hits = [...have].filter((k) => want.has(k)).length;
  return {
    valid: true,
    precision: have.size === 0 ? 0 : hits / have.size,
    recall: want.size === 0 ? 1 : hits / want.size,
  };
}

// ------------------------------------------------------------- plumbing

const results: Record<string, unknown> = {};
const logEl = () => document.getElementById("log")!;
function log(line: string) {
  logEl().textContent += `${line}\n`;
  logEl().scrollTop = logEl().scrollHeight;
}
function record(key: string, value: unknown) {
  results[key] = value;
  document.getElementById("results")!.textContent = JSON.stringify(
    results,
    null,
    2,
  );
}

let worker: Worker | undefined;
let nextId = 1;
const waiting = new Map<
  number,
  {
    resolve: (v: Extract<FromWorker, { type: "done" }>) => void;
    reject: (e: Error) => void;
  }
>();
let onLoad: ((m: FromWorker) => void) | undefined;

function llmWorker(): Worker {
  if (worker !== undefined) return worker;
  worker = new Worker("/llm_worker.bundle.js");
  worker.onmessage = (event: MessageEvent<FromWorker>) => {
    const msg = event.data;
    if (msg.type === "progress" || msg.type === "loaded") onLoad?.(msg);
    if (msg.type === "token") {
      document.getElementById("stream")!.textContent += msg.text;
    }
    if (msg.type === "done") {
      waiting.get(msg.id)?.resolve(msg);
      waiting.delete(msg.id);
    }
    if (msg.type === "error") {
      if (msg.id !== undefined) {
        waiting.get(msg.id)?.reject(new Error(msg.message));
        waiting.delete(msg.id);
      } else onLoad?.(msg);
    }
  };
  return worker;
}

function generate(
  system: string,
  prompt: string,
  opts: {
    tools?: Tool[];
    constrained?: boolean;
    maxOutputTokens?: number;
  } = {},
) {
  const id = nextId++;
  document.getElementById("stream")!.textContent = "";
  const msg: ToWorker = {
    type: "generate",
    id,
    system,
    prompt,
    tools: opts.tools,
    constrained: opts.constrained,
    maxOutputTokens: opts.maxOutputTokens ?? 256,
  };
  return new Promise<Extract<FromWorker, { type: "done" }>>(
    (resolve, reject) => {
      waiting.set(id, { resolve, reject });
      llmWorker().postMessage(msg);
    },
  );
}

// ---------------------------------------------------------------- steps

async function env() {
  const gpu = (navigator as Navigator & { gpu?: GPU }).gpu;
  const adapter = await gpu?.requestAdapter();
  const info = adapter?.info;
  const value = {
    userAgent: navigator.userAgent,
    crossOriginIsolated: globalThis.crossOriginIsolated,
    deviceMemoryGB:
      (navigator as Navigator & { deviceMemory?: number }).deviceMemory,
    hardwareConcurrency: navigator.hardwareConcurrency,
    webgpu: gpu !== undefined,
    adapter: info && {
      vendor: info.vendor,
      architecture: info.architecture,
      device: info.device,
      description: info.description,
    },
    shaderF16: adapter?.features.has("shader-f16") ?? false,
    maxBufferSize: adapter?.limits.maxBufferSize,
    maxStorageBufferBindingSize: adapter?.limits.maxStorageBufferBindingSize,
    jspi: "Suspending" in WebAssembly,
  };
  record("env", value);
  return value;
}

async function modelSize(name: ModelName) {
  const r = await fetch(MODELS[name], { method: "HEAD" });
  return Number(r.headers.get("content-length"));
}

async function load(name: ModelName) {
  const size = await modelSize(name);
  log(`loading ${name} (${(size / 2 ** 30).toFixed(2)} GiB)`);
  const started = performance.now();
  const loaded = await new Promise<Extract<FromWorker, { type: "loaded" }>>(
    (resolve, reject) => {
      onLoad = (msg) => {
        if (msg.type === "progress") {
          log(
            `  ${(msg.loaded / 2 ** 20).toFixed(0)} / ${
              (msg.total / 2 ** 20).toFixed(0)
            } MiB`,
          );
        } else if (msg.type === "loaded") resolve(msg);
        else if (msg.type === "error") reject(new Error(msg.message));
      };
      llmWorker().postMessage(
        {
          type: "load",
          model: MODELS[name],
          maxNumTokens: MAX_NUM_TOKENS,
        } satisfies ToWorker,
      );
    },
  );
  const value = {
    model: name,
    sizeBytes: size,
    maxNumTokens: MAX_NUM_TOKENS,
    totalMs: performance.now() - started,
    ...loaded,
  };
  delete (value as { type?: string }).type;
  record(`load_${loaded.fromCache ? "cached" : "cold"}`, value);
  log(`loaded ${name}: ${JSON.stringify(value)}`);
  return value;
}

function summarize(bench: Bench, run: Extract<FromWorker, { type: "done" }>) {
  return {
    prefillTokens: bench.lastPrefillTokenCount,
    prefillTokPerS: Math.round(bench.lastPrefillTokensPerSecond),
    decodeTokens: bench.lastDecodeTokenCount,
    decodeTokPerS: Math.round(bench.lastDecodeTokensPerSecond * 10) / 10,
    ttftMs: Math.round(bench.timeToFirstTokenInSecond * 1000),
    firstChunkMs: run.firstTokenMs && Math.round(run.firstTokenMs),
    wallMs: Math.round(run.wallMs),
  };
}

async function actions(repeat = 1) {
  const rows: {
    prompt: string;
    json: {
      strict: boolean;
      lenient: boolean;
      sensible: boolean;
      [k: string]: unknown;
    };
    tool: { valid: boolean; sensible: boolean; [k: string]: unknown };
  }[] = [];
  for (let r = 0; r < repeat; r++) {
    for (const task of ACTION_TASKS) {
      const json = await generate(ACTION_SYSTEM, task.prompt);
      const parsed = parseAction(json.text);
      const tool = await generate(TOOL_SYSTEM, task.prompt, { tools: TOOLS })
        .catch((error) => {
          throw new Error(`tool mode, "${task.prompt}": ${error}`);
        });
      const call = tool.toolCalls?.[0]?.function;
      const toolAction = call === undefined
        ? null
        : validateAction({ action: call.name, ...call.arguments });
      rows.push({
        prompt: task.prompt,
        json: {
          text: json.text,
          strict: parsed.strict !== null,
          lenient: parsed.lenient !== null,
          sensible: parsed.lenient !== null &&
            task.expect.includes(parsed.lenient.action),
          ...summarize(json.bench, json),
        },
        tool: {
          calls: tool.toolCalls?.length ?? 0,
          text: tool.text,
          valid: toolAction !== null,
          sensible: toolAction !== null &&
            task.expect.includes(toolAction.action),
          ...summarize(tool.bench, tool),
        },
      });
      log(
        `action: ${task.prompt} → json ${json.text.slice(0, 80)} | tool ${
          JSON.stringify(call)
        }`,
      );
    }
  }
  const rate = (f: (r: (typeof rows)[number]) => boolean) =>
    `${rows.filter(f).length}/${rows.length}`;
  const value = {
    jsonStrict: rate((r) => r.json.strict),
    jsonLenient: rate((r) => r.json.lenient),
    jsonSensible: rate((r) => r.json.sensible),
    toolValid: rate((r) => r.tool.valid),
    toolSensible: rate((r) => r.tool.sensible),
    rows,
  };
  record("actions", value);
  return value;
}

async function map(lines = 120) {
  const { text, expected } = syntheticLog(lines);
  const run = await generate(MAP_SYSTEM, text, { maxOutputTokens: 512 });
  const value = {
    lines,
    expectedErrors: expected.length,
    ...scoreMap(run.text, expected),
    output: run.text,
    ...summarize(run.bench, run),
  };
  record(`map_${lines}`, value);
  log(`map ${lines} lines: ${JSON.stringify({ ...value, output: undefined })}`);
  return value;
}

/** Boot the sandbox the way src/page.ts does, minus the terminal: the
 * coordinator worker, window.yurt over it, and Jupyter behind it. */
let yurt: Yurt | undefined;
async function boot() {
  const started = performance.now();
  const coordinator = new Worker("/coordinator.bundle.js");
  attachGuestWorkerFactory(coordinator);
  const pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  let nextReq = 1;
  const ask = <T>(message: Record<string, unknown>) =>
    new Promise<T>((resolve, reject) => {
      const req = nextReq++;
      pending.set(req, { resolve: resolve as (v: unknown) => void, reject });
      coordinator.postMessage({ ...message, req });
    });
  const transport: YurtTransport = {
    spawn: (cmd: string, opts: ExecOptions) =>
      ask({ type: "yurt-spawn", cmd, opts }),
    wait: (id: string) => ask({ type: "yurt-wait", id, raw: false }),
    waitRaw: (id: string) => ask({ type: "yurt-wait", id, raw: true }),
    kill: (id: string, signal?: string) =>
      ask({ type: "yurt-kill", id, signal }),
    list: () => ask({ type: "yurt-list" }),
  };
  let status: "booting" | "running" | "failed" = "booting";
  let shellUp: () => void = () => {};
  let fail: (e: Error) => void = () => {};
  const ready = new Promise<void>((resolve, reject) => {
    shellUp = resolve;
    fail = reject;
  });
  let notebookUp: () => void = () => {};
  const notebook = new Promise<void>((resolve) => (notebookUp = resolve));
  let cellDone: (v: unknown) => void = () => {};
  coordinator.onmessage = (event) => {
    const msg = event.data;
    if (msg.type === "status" && msg.text === "") {
      status = "running";
      shellUp();
    }
    if (msg.type === "error" && status === "booting") {
      status = "failed";
      fail(new Error(msg.message));
    }
    if (msg.type === "notebook-ready") notebookUp();
    if (msg.type === "cell-result" || msg.type === "cell-error") cellDone(msg);
    if (msg.type === "yurt-reply") {
      const waiter = pending.get(msg.req);
      pending.delete(msg.req);
      if (msg.ok) waiter?.resolve(msg.value);
      else waiter?.reject(new Error(msg.error ?? "yurt request failed"));
    }
  };
  yurt = createYurt(transport, { current: () => status, ready });
  (globalThis as { yurt?: Yurt }).yurt = yurt;
  coordinator.postMessage({
    type: "start",
    cols: 80,
    rows: 24,
    isolated: globalThis.crossOriginIsolated === true,
  });
  await ready;
  const shellMs = performance.now() - started;
  log(`sandbox up in ${Math.round(shellMs)} ms; waiting for Jupyter`);
  await notebook;
  const cell = new Promise((resolve) => (cellDone = resolve));
  coordinator.postMessage({
    type: "cell",
    id: "spike",
    code: "sum(range(10))",
  });
  const cellResult = await cell;
  const value = {
    shellMs: Math.round(shellMs),
    jupyterMs: Math.round(performance.now() - started),
    cell: cellResult,
  };
  record("boot", value);
  return value;
}

/** The controller loop in miniature: the model proposes one action per
 * step, the controller validates and runs it through window.yurt, and the
 * transcript (not the model) carries the state. */
async function loop(maxSteps = 4) {
  if (yurt === undefined) throw new Error("boot the sandbox first");
  const truth = (await yurt.exec("wc -l < /etc/passwd")).stdout.trim();
  const task = "How many lines are in /etc/passwd? Answer with the number.";
  const transcript: string[] = [`Task: ${task}`];
  const steps = [];
  const started = performance.now();
  for (let step = 0; step < maxSteps; step++) {
    const run = await generate(ACTION_SYSTEM, transcript.join("\n\n"));
    const { lenient: action } = parseAction(run.text);
    steps.push({ output: run.text, action, ...summarize(run.bench, run) });
    if (action === null) {
      transcript.push(`Your reply was not a valid action: ${run.text}`);
      continue;
    }
    if (action.action === "answer") break;
    const observation = action.action === "exec"
      ? await yurt.exec(action.cmd, { timeoutMs: 10_000 }).then((r) =>
        `exit ${"code" in r ? r.code : "stuck"}\n${r.stdout.slice(0, 2000)}${
          r.stderr.slice(0, 500)
        }`
      )
      : new TextDecoder().decode(await yurt.fs.read(action.path)).slice(
        0,
        2000,
      );
    transcript.push(
      `You ran ${JSON.stringify(action)}.\nResult:\n${observation}`,
    );
  }
  const final = steps.at(-1)?.action;
  const value = {
    truth,
    answered: final?.action === "answer",
    correct: final?.action === "answer" && final.text.includes(truth),
    steps,
    wallMs: Math.round(performance.now() - started),
  };
  record("loop", value);
  log(`loop: ${JSON.stringify({ ...value, steps: steps.length })}`);
  return value;
}

/** Chrome's whole-agent memory figure (page + workers), where available. */
async function memory(label: string) {
  const measure = (performance as Performance & {
    measureUserAgentSpecificMemory?: () => Promise<{ bytes: number }>;
  }).measureUserAgentSpecificMemory;
  const value = measure === undefined
    ? { unsupported: true }
    : { bytes: (await measure.call(performance)).bytes };
  record(`memory_${label}`, value);
  return value;
}

/** A generation plus a tool call, counting resources the page fetched
 * meanwhile: after the cached load this should be zero. */
async function offlineRun() {
  const before = performance.getEntriesByType("resource").length;
  const value: Record<string, unknown> = { online: navigator.onLine };
  try {
    const run = await generate(
      ACTION_SYSTEM,
      "How many lines are in /etc/passwd?",
    );
    value.generation = { output: run.text, ...summarize(run.bench, run) };
  } catch (error) {
    value.generationError = String(error);
  }
  if (yurt !== undefined) {
    try {
      const exec = await yurt.exec("uname -a");
      value.exec = {
        code: "code" in exec ? exec.code : "stuck",
        stdout: exec.stdout.trim(),
      };
    } catch (error) {
      value.execError = String(error);
    }
    try {
      value.read = new TextDecoder().decode(await yurt.fs.read("/etc/hostname"))
        .trim();
    } catch (error) {
      value.readError = String(error);
    }
  }
  value.pageRequests = performance.getEntriesByType("resource").length - before;
  record("offline", value);
  return value;
}

const cancel = () =>
  llmWorker().postMessage({ type: "cancel" } satisfies ToWorker);

const spike = {
  env,
  load,
  actions,
  map,
  boot,
  loop,
  memory,
  offlineRun,
  cancel,
  results,
};
(globalThis as { llmSpike?: typeof spike }).llmSpike = spike;

// --------------------------------------------------------------- buttons

function wire(id: string, run: () => Promise<unknown>) {
  const button = document.getElementById(id) as HTMLButtonElement;
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      await run();
    } catch (error) {
      log(`${id} failed: ${error instanceof Error ? error.message : error}`);
    } finally {
      button.disabled = false;
    }
  });
}

const modelSelect = () =>
  (document.getElementById("model") as HTMLSelectElement).value as ModelName;
wire("load", () => load(modelSelect()));
wire("actions", () => actions());
wire("map", () => map());
wire("boot", () => boot());
wire("loop", () => loop());
wire("offline", () => offlineRun());
document.getElementById("cancel")!.addEventListener("click", cancel);
const net = document.getElementById("net")!;
const showNet =
  () => (net.textContent = navigator.onLine ? "online" : "OFFLINE");
globalThis.addEventListener("online", showNet);
globalThis.addEventListener("offline", showNet);
showNet();
await env();
for (const name of Object.keys(MODELS) as ModelName[]) {
  const size = await modelSize(name).catch(() => NaN);
  const option = document.querySelector<HTMLOptionElement>(
    `option[value=${name}]`,
  )!;
  option.textContent = Number.isNaN(size)
    ? `${name} (not fetched: scripts/fetch-llm.sh ${name})`
    : `${name} (${(size / 2 ** 30).toFixed(2)} GiB download)`;
}
