/**
 * The page's side of the inference worker (src/llm_worker.ts): load one
 * pinned model, then generate as the agent controller's `Model`. A worker
 * that dies rejects everything waiting on it rather than leaving the pane
 * spinning.
 */
import type { Model, ModelStats } from "./agent.ts";
import type { LocalModel } from "./llm_models.ts";
import { MAX_NUM_TOKENS } from "./llm_models.ts";
import type { FromWorker, ToWorker } from "./llm_worker.ts";

export type LoadProgress =
  | { phase: "download"; loaded: number; total: number }
  | { phase: "start" };

export type Loaded = Extract<FromWorker, { type: "loaded" }>;

type Done = Extract<FromWorker, { type: "done" }>;

export type LocalLlm = Model & {
  readonly loaded: Loaded;
  /** Tokens of the last prompt and the engine's budget, for the pane's meter. */
  lastStats?: ModelStats;
  onToken?: (text: string) => void;
  dispose(): void;
};

export async function loadLocalModel(
  model: LocalModel,
  onProgress: (p: LoadProgress) => void,
): Promise<LocalLlm> {
  const worker = new Worker("/llm_worker.bundle.js");
  let nextId = 1;
  const waiting = new Map<
    number,
    { resolve: (d: Done) => void; reject: (e: Error) => void }
  >();
  let loading:
    | { resolve: (l: Loaded) => void; reject: (e: Error) => void }
    | undefined;
  const failAll = (error: Error) => {
    loading?.reject(error);
    loading = undefined;
    for (const w of waiting.values()) w.reject(error);
    waiting.clear();
  };
  // Tokens stream to whoever holds the model once it exists.
  const holder: { llm?: LocalLlm } = {};
  worker.onerror = (event) => {
    event.preventDefault();
    failAll(new Error(event.message || "the model worker failed"));
  };
  worker.onmessage = (event: MessageEvent<FromWorker>) => {
    const msg = event.data;
    if (msg.type === "progress") {
      onProgress({ phase: "download", ...msg });
      if (msg.loaded === msg.total) onProgress({ phase: "start" });
    } else if (msg.type === "loaded") {
      loading?.resolve(msg);
      loading = undefined;
    } else if (msg.type === "token") {
      holder.llm?.onToken?.(msg.text);
    } else if (msg.type === "done") {
      waiting.get(msg.id)?.resolve(msg);
      waiting.delete(msg.id);
    } else if (msg.type === "error") {
      const error = new Error(msg.message);
      if (msg.id === undefined) {
        loading?.reject(error);
        loading = undefined;
      } else {
        waiting.get(msg.id)?.reject(error);
        waiting.delete(msg.id);
      }
    }
  };
  const post = (msg: ToWorker) => worker.postMessage(msg);
  let loaded: Loaded;
  try {
    loaded = await new Promise<Loaded>((resolve, reject) => {
      loading = { resolve, reject };
      post({
        type: "load",
        model: `/llm/${model.file}`,
        cacheKey: `/llm/${model.file}?sha256=${model.sha256}`,
        maxNumTokens: MAX_NUM_TOKENS,
      });
    });
  } catch (error) {
    worker.terminate();
    throw error;
  }
  const llm: LocalLlm = {
    loaded,
    generate(system, prompt, signal) {
      const id = nextId++;
      const done = new Promise<Done>((resolve, reject) => {
        waiting.set(id, { resolve, reject });
        post({ type: "generate", id, system, prompt, maxOutputTokens: 512 });
      });
      const cancel = () => post({ type: "cancel" });
      signal.addEventListener("abort", cancel, { once: true });
      return done.then((d) => {
        const stats = {
          promptTokens: d.bench.lastPrefillTokenCount,
          outputTokens: d.bench.lastDecodeTokenCount,
        };
        llm.lastStats = stats;
        return { text: d.text, stats };
      }).finally(() => signal.removeEventListener("abort", cancel));
    },
    dispose() {
      failAll(new Error("the model was unloaded"));
      worker.terminate();
    },
  };
  holder.llm = llm;
  return llm;
}
