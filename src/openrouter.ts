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
 * src/agent_models_config.ts). Only the list's models: a link cannot add
 * one, which would bill the visitor's key for a model nobody offered. */
export function openrouterModels(
  list: { id: string; label: string }[],
): RemoteModel[] {
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

/** Where storage refuses the key (blocked, or full), it lives here. */
let memoryKey: string | undefined;

export function openrouterKey(): string | undefined {
  try {
    return localStorage.getItem(KEY_STORAGE) ?? memoryKey;
  } catch {
    return memoryKey;
  }
}

/** A key as OpenRouter issues them: printable ASCII, no spaces. A pasted one
 * with a stray newline or quote would fail every request without a 401. */
export function validKey(key: string): boolean {
  return /^[\x21-\x7e]{8,}$/.test(key);
}

export function setOpenrouterKey(key: string | undefined): void {
  memoryKey = undefined;
  try {
    if (key === undefined) localStorage.removeItem(KEY_STORAGE);
    else localStorage.setItem(KEY_STORAGE, key);
  } catch {
    memoryKey = key;
  }
}

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
  // Back to this very page from OpenRouter (the back/forward cache): no
  // sign-in is coming back, so none is waiting for a later load to finish.
  addEventListener("pageshow", (event) => {
    if ((event as PageTransitionEvent).persisted) forgetSignIn();
  }, { once: true });
  leave(signInUrl(location.href, challenge));
}

function forgetSignIn(): void {
  try {
    sessionStorage.removeItem(SIGN_IN_STORAGE);
  } catch { /* blocked: nothing was kept */ }
}

function pendingSignIn(): SignIn | undefined {
  try {
    const raw = sessionStorage.getItem(SIGN_IN_STORAGE);
    return raw === null ? undefined : JSON.parse(raw) as SignIn;
  } catch {
    return undefined;
  }
}

/** First thing on a load back from sign-in, with a code or without one (a
 * sign-in the visitor cancelled): put the fragment (`#agent`) back, before
 * the page reads it to choose its tab. */
export function restoreAfterSignIn(): void {
  const url = new URL(location.href);
  const signIn = pendingSignIn();
  if (signIn === undefined) return;
  if (url.hash === "" && signIn.hash !== "") {
    url.hash = signIn.hash;
    history.replaceState(history.state, "", url.href);
  }
}

/** On the way back from sign-in: the model the visitor chose before
 * leaving, at once, and `done`: the trade of `?code=` for a key, kept, with
 * the code taken out of the address. It resolves to why it failed, if it
 * did; a load that is no return from sign-in resolves at once. */
export function finishOpenrouterSignIn(): {
  model?: string;
  done: Promise<string | undefined>;
} {
  const url = new URL(location.href);
  const code = url.searchParams.get("code");
  const signIn = pendingSignIn();
  if (signIn === undefined) {
    // A code with no sign-in of this tab's to finish: not kept in the address.
    if (code !== null) {
      url.searchParams.delete("code");
      history.replaceState(history.state, "", url.href);
    }
    return { done: Promise.resolve(undefined) };
  }
  forgetSignIn();
  if (code === null) {
    return {
      model: signIn.model,
      done: Promise.resolve("OpenRouter sign-in was cancelled"),
    };
  }
  url.searchParams.delete("code");
  history.replaceState(history.state, "", url.href);
  return { model: signIn.model, done: exchange(code, signIn.verifier) };
}

async function exchange(
  code: string,
  verifier: string,
): Promise<string | undefined> {
  try {
    const response = await fetch(`${API}/auth/keys`, {
      method: "POST",
      signal: AbortSignal.timeout(15_000),
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code,
        code_verifier: verifier,
        code_challenge_method: "S256",
      }),
    });
    const body = await response.json().catch(() => ({})) as { key?: string };
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

/** How long to wait before asking again: Retry-After when it gives a number
 * of seconds (at least a second, at most 10), else a growing back-off. */
export function retryDelay(
  retryAfter: string | null,
  attempt: number,
  baseMs: number,
): number {
  const seconds = Number(retryAfter);
  if (
    retryAfter !== null && retryAfter.trim() !== "" &&
    Number.isFinite(seconds) && seconds >= 0
  ) {
    return Math.min(Math.max(seconds * 1000, Math.min(1000, baseMs)), 10_000);
  }
  return baseMs * (attempt + 1);
}

export function openrouterModel(
  modelId: string,
  options: { retryBaseMs?: number } = {},
): Model & { lastStats?: ModelStats; onToken?: (text: string) => void } {
  const retryBaseMs = options.retryBaseMs ?? 2000;
  const m: Model & {
    lastStats?: ModelStats;
    /** The pane's live line for the step: what the wait is. */
    onToken?: (text: string) => void;
  } = {
    async generate(system, prompt, signal) {
      const key = openrouterKey();
      if (key === undefined) throw new Error("not signed in to OpenRouter");
      // Reasoning off, unless the model says it cannot be (then once more,
      // with its reasoning on).
      let reasoning: { enabled: false } | undefined = { enabled: false };
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
            max_tokens: 4096,
            // Reasoning models spend the whole budget thinking otherwise.
            ...(reasoning ? { reasoning } : {}),
            temperature: 0,
          }),
          signal,
        });
      // Free models are often rate-limited upstream for a moment: retry.
      let response = await request();
      if (response.status === 400) {
        const text = await response.clone().text().catch(() => "");
        if (/reasoning is mandatory/i.test(text)) {
          reasoning = undefined;
          response = await request();
        }
      }
      for (let attempt = 0; response.status === 429 && attempt < 3; attempt++) {
        await response.body?.cancel();
        const wait = retryDelay(
          response.headers.get("retry-after"),
          attempt,
          retryBaseMs,
        );
        m.onToken?.(
          `\nthe model is busy (rate-limited); asking again in ${
            Math.ceil(wait / 1000)
          } s`,
        );
        await sleep(wait, signal);
        response = await request();
      }
      const body = await response.json().catch(() => ({})) as {
        choices?: {
          message?: { content?: string | null };
          finish_reason?: string;
          error?: { message?: string };
        }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
        error?: { message?: string; metadata?: { raw?: string } };
      };
      const why = `OpenRouter ${response.status}: ${
        body.error?.metadata?.raw ?? body.error?.message ?? "no reply"
      }`.slice(0, 300);
      if (response.status === 401) {
        setOpenrouterKey(undefined);
        throw new Error(why);
      }
      const choice = body.choices?.[0];
      // A 200 can still carry the provider's error, with no text.
      if (choice?.error !== undefined) {
        throw new Error(
          `OpenRouter: ${choice.error.message ?? "the model failed"}`.slice(
            0,
            300,
          ),
        );
      }
      const text = choice?.message?.content;
      if (!response.ok || typeof text !== "string") throw new Error(why);
      if (choice?.finish_reason === "length") {
        throw new Error(
          "the model's reply was cut off at 4096 tokens; ask for less at once",
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
