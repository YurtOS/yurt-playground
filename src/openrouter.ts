/**
 * The agent's `Model` through OpenRouter (https://openrouter.ai): the
 * visitor's own account, so the model runs on OpenRouter's servers and the
 * tab holds only the sandbox. That is what lets a tablet run the agent.
 *
 * The key is the visitor's: "Sign in with OpenRouter" (OAuth with PKCE)
 * gives this page one, or the visitor pastes one. It stays in this
 * browser's localStorage and goes only to openrouter.ai.
 */
import type { Model, ModelStats } from "./agent.ts";

export const OPENROUTER_ORIGIN = "https://openrouter.ai";
const API = `${OPENROUTER_ORIGIN}/api/v1`;
const KEY_STORAGE = "yurt-openrouter-key";
const VERIFIER_STORAGE = "yurt-openrouter-verifier";

export type RemoteModel = {
  id: string;
  label: string;
  choice: string;
  /** Set for OpenRouter models: the model's OpenRouter id. */
  openrouter?: string;
};

/** Models that answer in the agent's one-JSON-action format (checked
 * 2026-11-09). Free ones are rate-limited, upstream and per account. */
export const OPENROUTER_MODELS: { id: string; label: string }[] = [
  {
    id: "nvidia/nemotron-3.5-super-vl:free",
    label: "NVIDIA Nemotron 3.5 Super",
  },
  {
    id: "nvidia/nemotron-3-ultra-550b-a55b:free",
    label: "NVIDIA Nemotron 3 Ultra",
  },
  { id: "cohere/north-mini-code:free", label: "Cohere North Mini Code" },
  {
    id: "nvidia/nemotron-3.5-lightning:free",
    label: "NVIDIA Nemotron 3.5 Lightning (fast)",
  },
  // Gemma 4 31B: the free one is often rate-limited upstream; the paid one
  // costs about a tenth of a cent a task.
  { id: "google/gemma-4-31b-it:free", label: "Gemma 4 31B" },
  { id: "google/gemma-4-31b-it", label: "Gemma 4 31B" },
];

export function openrouterModels(extra?: string): RemoteModel[] {
  const list = [...OPENROUTER_MODELS];
  if (extra && !list.some((m) => m.id === extra)) {
    list.unshift({ id: extra, label: extra });
  }
  return list.map((m) => ({
    id: `openrouter:${m.id}`,
    label: `${m.label} (OpenRouter, ${
      m.id.endsWith(":free") ? "free" : "paid"
    })`,
    choice: `${m.label} — OpenRouter, ${
      m.id.endsWith(":free") ? "free" : "paid"
    }`,
    openrouter: m.id,
  }));
}

export function openrouterKey(): string | undefined {
  try {
    return localStorage.getItem(KEY_STORAGE) ?? undefined;
  } catch {
    return undefined;
  }
}

export function setOpenrouterKey(key: string | undefined): void {
  try {
    if (key === undefined) localStorage.removeItem(KEY_STORAGE);
    else localStorage.setItem(KEY_STORAGE, key);
  } catch {
    // No storage (a private window): the key lasts until the page closes.
  }
  memoryKey = key;
}
let memoryKey: string | undefined;

const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_")
    .replace(/=+$/, "");

/** Leave for OpenRouter's sign-in; it comes back to this page with `?code=`. */
export async function signInWithOpenrouter(): Promise<void> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64url(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
    ),
  );
  sessionStorage.setItem(VERIFIER_STORAGE, verifier);
  const back = new URL(location.href);
  back.searchParams.delete("code");
  const url = new URL(`${OPENROUTER_ORIGIN}/auth`);
  url.searchParams.set("callback_url", back.href);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  location.assign(url.href);
}

/** On the way back from sign-in: trade `?code=` for a key, keep it, and
 * take the code out of the address. Resolves to why it failed, if it did. */
export async function finishOpenrouterSignIn(): Promise<string | undefined> {
  const url = new URL(location.href);
  const code = url.searchParams.get("code");
  let verifier: string | null = null;
  try {
    verifier = sessionStorage.getItem(VERIFIER_STORAGE);
  } catch { /* no storage */ }
  if (code === null || verifier === null) return undefined;
  url.searchParams.delete("code");
  history.replaceState(history.state, "", url.href);
  sessionStorage.removeItem(VERIFIER_STORAGE);
  try {
    const response = await fetch(`${API}/auth/keys`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code,
        code_verifier: verifier,
        code_challenge_method: "S256",
      }),
    });
    const body = await response.json() as { key?: string };
    if (!response.ok || typeof body.key !== "string") {
      return `OpenRouter sign-in failed (${response.status})`;
    }
    setOpenrouterKey(body.key);
    return undefined;
  } catch (error) {
    return `OpenRouter sign-in failed: ${
      error instanceof Error ? error.message : error
    }`;
  }
}

export function openrouterModel(
  modelId: string,
): Model & { lastStats?: ModelStats } {
  const m: Model & { lastStats?: ModelStats } = {
    async generate(system, prompt, signal) {
      const key = openrouterKey() ?? memoryKey;
      if (key === undefined) throw new Error("not signed in to OpenRouter");
      let response: Response | undefined;
      // Free models are often rate-limited upstream for a moment: retry.
      for (let attempt = 0; attempt < 4; attempt++) {
        response = await fetch(`${API}/chat/completions`, {
          method: "POST",
          headers: {
            "authorization": `Bearer ${key}`,
            "content-type": "application/json",
            "x-title": "Yurt playground",
          },
          body: JSON.stringify({
            model: modelId,
            messages: [
              { role: "system", content: system },
              { role: "user", content: prompt },
            ],
            max_tokens: 1024,
            // Reasoning models spend the whole budget thinking otherwise.
            reasoning: { enabled: false },
            temperature: 0,
          }),
          signal,
        });
        if (response.status !== 429 || attempt === 3) break;
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      }
      const body = await response!.json().catch(() => ({})) as {
        choices?: { message?: { content?: string } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
        error?: { message?: string; metadata?: { raw?: string } };
      };
      const text = body.choices?.[0]?.message?.content;
      if (!response!.ok || typeof text !== "string") {
        if (response!.status === 401) setOpenrouterKey(undefined);
        throw new Error(
          `OpenRouter ${response!.status}: ${
            body.error?.metadata?.raw ?? body.error?.message ?? "no reply"
          }`.slice(0, 300),
        );
      }
      const stats = {
        promptTokens: body.usage?.prompt_tokens ?? 0,
        outputTokens: body.usage?.completion_tokens ?? 0,
      };
      m.lastStats = stats;
      return { text, stats };
    },
  };
  return m;
}
