/**
 * The agent's model when it runs outside the browser: Ollama on the visitor's
 * own computer. The page calls it directly, as the sandbox's tools are the
 * page's too, so the guest gets no route out. Nothing here may run before the
 * visitor asks for it: a public page reaching this address can make the browser
 * ask for local-network access, and a visit must not cause that.
 */
import { DEFAULT_LIMITS, type Limits, type Model } from "./agent.ts";
import type { ModelStats } from "./agent.ts";

/** Ollama's default address, the one the CSP names (src/csp.ts). */
export const OLLAMA_URL = "http://127.0.0.1:11434";

/** Context window asked of the model: prompt + reply, in tokens. */
export const OLLAMA_CONTEXT_TOKENS = 16384;

export const OLLAMA_MAX_OUTPUT_TOKENS = 2048;

/** More room than the 4,096-token engine in the tab, and longer: a large model
 * can take a minute or more to load before its first token. */
export const OLLAMA_LIMITS: Limits = {
  ...DEFAULT_LIMITS,
  maxSteps: 16,
  maxObservation: 6000,
  // Dense output such as hex runs at about 2 characters a token (measured on
  // llama3.2), not the usual 3.5: at that rate this, the system prompt and the
  // reply still fit OLLAMA_CONTEXT_TOKENS.
  maxPrompt: 24_000,
  timeoutMs: 600_000,
};

const action = (name: string, ...fields: string[]) => ({
  type: "object",
  properties: {
    action: { const: name },
    ...Object.fromEntries(fields.map((f) => [f, { type: "string" }])),
  },
  required: ["action", ...fields],
  additionalProperties: false,
});

/** The controller's closed set of actions (src/agent.ts), as a schema for the
 * reply. It is a hint: Ollama 0.20.4 let gemma4 answer outside it, so what holds
 * the model to these actions is the controller's own validation. */
export const ACTION_SCHEMA = {
  anyOf: [
    action("exec", "cmd"),
    action("read_file", "path"),
    action("write_file", "path", "text"),
    action("answer", "text"),
  ],
};

export type OllamaLlm = Model & {
  lastStats?: ModelStats;
  onToken?: (text: string) => void;
};

/** What to tell the visitor when Ollama did not answer. The browser reports
 * "not running", "origin not allowed" and "access refused" as one failure, so
 * this names all three. */
export function ollamaHelp(origin: string): string {
  return `Could not reach Ollama at ${OLLAMA_URL}. If it is running, quit it ` +
    `first. Then start it, allowing this page: OLLAMA_ORIGINS=${origin} ollama ` +
    "serve. If the browser asks whether this site may reach your local " +
    "network, allow it.";
}

/** The models Ollama has installed, most recently changed first. Its cloud
 * models are left out: they send the prompt away, and the pane promises it stays
 * on this computer. The time limit is long enough to answer the browser's
 * local-network question, which holds this request until it is answered. */
export async function listOllamaModels(
  base: string = OLLAMA_URL,
  timeoutMs = 60_000,
): Promise<string[]> {
  const response = await fetch(`${base}/api/tags`, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Ollama answered ${response.status}`);
  }
  const { models }: { models: { name: string }[] } = await response.json();
  return models.map((m) => m.name).filter((n) => !/[:-]cloud$/.test(n));
}

type ChatLine = {
  error?: string;
  message?: { content?: string };
  done?: boolean;
  prompt_eval_count?: number;
  eval_count?: number;
};

/** A reply's newline-delimited JSON, whole lines at a time however the network
 * cut it. */
async function* chatLines(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<ChatLine> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      const lines = pending.split("\n");
      pending = lines.pop()!;
      for (const line of lines) {
        if (line.trim() !== "") yield JSON.parse(line);
      }
    }
    if (pending.trim() !== "") yield JSON.parse(pending);
  } finally {
    // A caller that stops at the done line must not leave the reply open.
    await reader.cancel();
  }
}

/** The reply's first JSON object, when it goes on after it: models often list
 * the steps they plan as further objects, and the controller takes exactly one
 * action. Any other reply is left for the controller to judge. */
export function firstObject(text: string): string {
  const start = text.indexOf("{");
  if (start < 0 || text.slice(0, start).trim() !== "") return text;
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return text.slice(start, i + 1);
  }
  return text;
}

/** `model` is read at each call: the visitor can change it between tasks, and
 * the pane locks the choice during one. */
export function ollamaModel(
  model: () => string,
  base: string = OLLAMA_URL,
): OllamaLlm {
  const llm: OllamaLlm = {
    async generate(system, prompt, signal) {
      const response = await fetch(`${base}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal,
        body: JSON.stringify({
          model: model(),
          stream: true,
          think: false,
          format: ACTION_SCHEMA,
          options: {
            num_ctx: OLLAMA_CONTEXT_TOKENS,
            num_predict: OLLAMA_MAX_OUTPUT_TOKENS,
          },
          messages: [
            { role: "system", content: system },
            { role: "user", content: prompt },
          ],
        }),
      });
      if (!response.ok || response.body === null) {
        const reason = await response.json().then(
          (b: ChatLine) => b.error,
          () => undefined,
        );
        throw new Error(reason ?? `Ollama answered ${response.status}`);
      }
      let text = "";
      for await (const line of chatLines(response.body)) {
        if (line.error !== undefined) throw new Error(line.error);
        const token = line.message?.content ?? "";
        if (token !== "") {
          text += token;
          llm.onToken?.(token);
        }
        if (line.done) {
          const stats = {
            // Absent when Ollama reused a cached prompt in full.
            promptTokens: line.prompt_eval_count ?? 0,
            outputTokens: line.eval_count ?? 0,
          };
          llm.lastStats = stats;
          return { text: firstObject(text), stats };
        }
      }
      throw new Error("Ollama's reply ended early");
    },
  };
  return llm;
}
