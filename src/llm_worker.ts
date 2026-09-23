/**
 * The #140 feasibility spike's inference worker: owns LiteRT-LM and its
 * WebGPU device, so generation never blocks the page (or the sandbox's
 * coordinator). A classic worker, because LiteRT-LM loads its emscripten
 * glue with importScripts.
 */
import {
  type Conversation,
  Engine,
  loadLiteRtLm,
  type Message,
  type Tool,
} from "@litert-lm/core";

export type ToWorker =
  | {
    type: "load";
    model: string;
    /** Where the bytes live in Cache Storage; a pinned model's key names
     * its sha256, so a new pin is a new entry (the default: the URL). */
    cacheKey?: string;
    maxNumTokens: number;
  }
  | {
    type: "generate";
    id: number;
    system: string;
    prompt: string;
    tools?: Tool[];
    constrained?: boolean;
    maxOutputTokens: number;
  }
  | { type: "cancel" };

export type Bench = {
  lastPrefillTokensPerSecond: number;
  lastPrefillTokenCount: number;
  lastDecodeTokensPerSecond: number;
  lastDecodeTokenCount: number;
  timeToFirstTokenInSecond: number;
};

export type FromWorker =
  | { type: "progress"; loaded: number; total: number }
  | {
    type: "loaded";
    /** Which of the four builds (relaxed-SIMD × JSPI) the loader chose. */
    wasmVariant: string;
    fromCache: boolean;
    downloadBytes: number;
    downloadMs: number;
    wasmMs: number;
    engineMs: number;
  }
  | { type: "token"; id: number; text: string }
  | {
    type: "done";
    id: number;
    text: string;
    toolCalls: Message["tool_calls"];
    firstTokenMs: number | null;
    wallMs: number;
    bench: Bench;
  }
  | { type: "error"; id?: number; message: string };

const CACHE = "yurt-llm";
const post = (msg: FromWorker) => self.postMessage(msg);
let engine: Engine | undefined;
let active: Conversation | undefined;
/** A cancel that arrived while the conversation was still being created. */
let cancelRequested = false;

/** The model's bytes from Cache Storage, fetching them first if absent.
 * Streamed straight into the cache (no tee), so a 2 GB download never sits
 * in memory; the Blob read back is disk-backed. */
async function modelBlob(url: string, key: string) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(key);
  if (cached !== undefined) {
    return {
      blob: await cached.blob(),
      fromCache: true,
      downloadBytes: 0,
      downloadMs: 0,
    };
  }
  const started = performance.now();
  const response = await fetch(url);
  if (!response.ok || response.body === null) {
    throw new Error(`${url}: HTTP ${response.status}`);
  }
  const total = Number(response.headers.get("content-length") ?? 0);
  let loaded = 0;
  let lastPost = 0;
  const counted = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        loaded += chunk.byteLength;
        if (loaded - lastPost > 16 * 1024 * 1024 || loaded === total) {
          lastPost = loaded;
          post({ type: "progress", loaded, total });
        }
        controller.enqueue(chunk);
      },
    }),
  );
  // Other pins of this file are dead weight (gigabytes): drop them first.
  for (const request of await cache.keys()) {
    const old = new URL(request.url);
    if (old.pathname === new URL(key, location.href).pathname) {
      await cache.delete(request);
    }
  }
  await cache.put(
    key,
    new Response(counted, { headers: { "content-length": String(total) } }),
  );
  const stored = await cache.match(key);
  if (stored === undefined) throw new Error("model vanished from the cache");
  return {
    blob: await stored.blob(),
    fromCache: false,
    downloadBytes: loaded,
    downloadMs: performance.now() - started,
  };
}

async function load(
  model: string,
  cacheKey: string,
  maxNumTokens: number,
): Promise<void> {
  // The glue resolves its .wasm against the worker's URL unless told.
  (self as unknown as { Module: unknown }).Module = {
    locateFile: (path: string) => `/llm/wasm/${path}`,
  };
  let t = performance.now();
  await loadLiteRtLm("/llm/wasm/");
  const wasmMs = performance.now() - t;
  const wasmVariant = performance.getEntriesByType("resource")
    .map((e) => e.name).find((name) => name.endsWith(".wasm")) ?? "unknown";
  const got = await modelBlob(model, cacheKey);
  t = performance.now();
  // No backend: the default, GPU_ARTISAN, is the one that streams the
  // weights in; the others copy the whole file into wasm memory first.
  engine = await Engine.create({
    model: got.blob,
    mainExecutorSettings: { maxNumTokens },
    benchmarkEnabled: true,
  });
  post({
    type: "loaded",
    wasmVariant: wasmVariant.split("/").pop()!,
    fromCache: got.fromCache,
    downloadBytes: got.downloadBytes,
    downloadMs: got.downloadMs,
    wasmMs,
    engineMs: performance.now() - t,
  });
}

async function generate(msg: Extract<ToWorker, { type: "generate" }>) {
  if (engine === undefined) throw new Error("no model loaded");
  const conversation = await engine.createConversation({
    preface: {
      messages: [{ role: "system", content: msg.system }],
      tools: msg.tools,
    },
    enableConstrainedDecoding: msg.constrained ?? false,
    sessionConfig: { maxOutputTokens: msg.maxOutputTokens },
  });
  active = conversation;
  if (cancelRequested) conversation.cancel();
  const started = performance.now();
  let firstTokenMs: number | null = null;
  let text = "";
  const toolCalls: NonNullable<Message["tool_calls"]> = [];
  try {
    const reader = conversation.sendMessageStreaming(msg.prompt).getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      firstTokenMs ??= performance.now() - started;
      toolCalls.push(...(value.tool_calls ?? []));
      const parts = typeof value.content === "string"
        ? [{ type: "text", text: value.content }]
        : value.content ?? [];
      for (const part of parts) {
        if (part.type === "text") {
          text += part.text;
          post({ type: "token", id: msg.id, text: part.text as string });
        }
      }
    }
    post({
      type: "done",
      id: msg.id,
      text,
      toolCalls,
      firstTokenMs,
      wallMs: performance.now() - started,
      bench: await conversation.getBenchmarkInfo(),
    });
  } finally {
    active = undefined;
    await conversation.delete();
  }
}

self.onmessage = async (event: MessageEvent<ToWorker>) => {
  const msg = event.data;
  if (msg.type === "cancel") {
    cancelRequested = true;
    active?.cancel();
    return;
  }
  try {
    if (msg.type === "load") {
      await load(msg.model, msg.cacheKey ?? msg.model, msg.maxNumTokens);
    } else {
      cancelRequested = false;
      await generate(msg);
    }
  } catch (error) {
    post({
      type: "error",
      id: msg.type === "generate" ? msg.id : undefined,
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
