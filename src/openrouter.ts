/**
 * The agent's `Model` through OpenRouter (https://openrouter.ai): the
 * visitor's own account, so the model runs on OpenRouter's servers and the
 * tab holds only the sandbox. That is what lets a tablet run the agent.
 *
 * The key is the visitor's: "Sign in with OpenRouter" (OAuth with PKCE)
 * gives this page one, or the visitor pastes one. It stays in this
 * browser's localStorage (in memory only, where storage is blocked) and
 * goes only to openrouter.ai.
 */
import type { Model, ModelStats } from "./agent.ts";

export const OPENROUTER_ORIGIN = "https://openrouter.ai";
const API = `${OPENROUTER_ORIGIN}/api/v1`;
const KEY_STORAGE = "yurt-openrouter-key";
/** The sign-in in flight: its PKCE verifier, and where to come back to. */
const SIGN_IN_STORAGE = "yurt-openrouter-sign-in";

export type RemoteModel = {
  id: string;
  label: string;
  choice: string;
  /** The model's OpenRouter id. */
  openrouter: string;
};

/** The pane's choices for `list` (agent-models.json's, see
 * src/agent_models_config.ts), with `extra` (`?model=openrouter:<id>`)
 * first when the list lacks it. */
export function openrouterModels(
  list: { id: string; label: string }[],
  extra?: string,
): RemoteModel[] {
  list = [...list];
  if (extra && !list.some((m) => m.id === extra)) {
    list.unshift({ id: extra, label: extra });
  }
  return list.map((m) => {
    const price = m.id.endsWith(":free") ? "free" : "paid";
    return {
      id: `openrouter:${m.id}`,
      label: `${m.label} (OpenRouter, ${price})`,
      choice: `${m.label} — OpenRouter, ${price}`,
      openrouter: m.id,
    };
  });
}

/** Where storage is blocked (a private window), the key lives here. */
let memoryKey: string | undefined;

export function openrouterKey(): string | undefined {
  try {
    return localStorage.getItem(KEY_STORAGE) ?? undefined;
  } catch {
    return memoryKey;
  }
}

export function setOpenrouterKey(key: string | undefined): void {
  try {
    if (key === undefined) localStorage.removeItem(KEY_STORAGE);
    else localStorage.setItem(KEY_STORAGE, key);
  } catch {
    memoryKey = key;
  }
}

/** The key OpenRouter refused: the pane goes back to signing in. */
export class OpenrouterSignedOut extends Error {}

const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_")
    .replace(/=+$/, "");

type SignIn = { verifier: string; hash: string; model: string };

/** Where OpenRouter's sign-in sends the visitor, given the page's address
 * now and the PKCE challenge. The fragment is left out: a provider that adds
 * `?code=` to the URL as a string would put it after the `#`. */
export function signInUrl(page: string, challenge: string): string {
  const back = new URL(page);
  back.searchParams.delete("code");
  back.hash = "";
  const url = new URL(`${OPENROUTER_ORIGIN}/auth`);
  url.searchParams.set("callback_url", back.href);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.href;
}

/** Leave for OpenRouter's sign-in, through `leave` (the page's own way out,
 * so the return does not read as a boot the browser cut off). It comes back
 * with `?code=`, to the same model. Rejects when storage is blocked: the
 * verifier would not survive the trip. */
export async function signInWithOpenrouter(
  model: string,
  leave: (url: string) => void,
): Promise<void> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64url(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
    ),
  );
  const signIn: SignIn = { verifier, hash: location.hash, model };
  try {
    sessionStorage.setItem(SIGN_IN_STORAGE, JSON.stringify(signIn));
  } catch {
    throw new Error(
      "this browser blocks site storage, so sign-in cannot finish; " +
        "paste an OpenRouter key instead",
    );
  }
  leave(signInUrl(location.href, challenge));
}

function pendingSignIn(): SignIn | undefined {
  try {
    const raw = sessionStorage.getItem(SIGN_IN_STORAGE);
    return raw === null ? undefined : JSON.parse(raw) as SignIn;
  } catch {
    return undefined;
  }
}

/** First thing on a load back from sign-in: put the fragment (`#agent`)
 * back, before the page reads it to choose its tab. */
export function restoreAfterSignIn(): void {
  const url = new URL(location.href);
  const signIn = pendingSignIn();
  if (!url.searchParams.has("code") || signIn === undefined) return;
  if (url.hash === "" && signIn.hash !== "") {
    url.hash = signIn.hash;
    history.replaceState(history.state, "", url.href);
  }
}

/** On the way back from sign-in: trade `?code=` for a key, keep it, and take
 * the code out of the address. Resolves to the model the visitor chose
 * before leaving, and why it failed, if it did. */
export async function finishOpenrouterSignIn(): Promise<
  { model?: string; error?: string }
> {
  const url = new URL(location.href);
  const code = url.searchParams.get("code");
  const signIn = pendingSignIn();
  if (code === null || signIn === undefined) return {};
  url.searchParams.delete("code");
  history.replaceState(history.state, "", url.href);
  try {
    sessionStorage.removeItem(SIGN_IN_STORAGE);
  } catch { /* blocked: nothing was kept */ }
  try {
    const response = await fetch(`${API}/auth/keys`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code,
        code_verifier: signIn.verifier,
        code_challenge_method: "S256",
      }),
    });
    const body = await response.json().catch(() => ({})) as { key?: string };
    if (!response.ok || typeof body.key !== "string") {
      return {
        model: signIn.model,
        error: `OpenRouter sign-in failed (${response.status})`,
      };
    }
    setOpenrouterKey(body.key);
    return { model: signIn.model };
  } catch (error) {
    return {
      model: signIn.model,
      error: `OpenRouter sign-in failed: ${
        error instanceof Error ? error.message : error
      }`,
    };
  }
}

/** Waits `ms`, or rejects at once when `signal` aborts. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", stop);
      resolve();
    }, ms);
    const stop = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", stop, { once: true });
  });
}

/** How long to wait before asking again: Retry-After when given (up to
 * 10 s), else a growing back-off. */
export function retryDelay(
  retryAfter: string | null,
  attempt: number,
  baseMs: number,
): number {
  const seconds = Number(retryAfter);
  if (retryAfter !== null && Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, 10_000);
  }
  return baseMs * (attempt + 1);
}

export function openrouterModel(
  modelId: string,
  options: { retryBaseMs?: number } = {},
): Model & { lastStats?: ModelStats } {
  const retryBaseMs = options.retryBaseMs ?? 2000;
  const m: Model & { lastStats?: ModelStats } = {
    async generate(system, prompt, signal) {
      const key = openrouterKey();
      if (key === undefined) {
        throw new OpenrouterSignedOut("not signed in to OpenRouter");
      }
      const request = () =>
        fetch(`${API}/chat/completions`, {
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
      // Free models are often rate-limited upstream for a moment: retry.
      let response = await request();
      for (let attempt = 0; response.status === 429 && attempt < 3; attempt++) {
        await response.body?.cancel();
        await sleep(
          retryDelay(response.headers.get("retry-after"), attempt, retryBaseMs),
          signal,
        );
        response = await request();
      }
      const body = await response.json().catch(() => ({})) as {
        choices?: { message?: { content?: string | null } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
        error?: { message?: string; metadata?: { raw?: string } };
      };
      const why = `OpenRouter ${response.status}: ${
        body.error?.metadata?.raw ?? body.error?.message ?? "no reply"
      }`.slice(0, 300);
      if (response.status === 401) {
        setOpenrouterKey(undefined);
        throw new OpenrouterSignedOut(why);
      }
      const text = body.choices?.[0]?.message?.content;
      if (!response.ok || typeof text !== "string") throw new Error(why);
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
