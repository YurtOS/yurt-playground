import { assertEquals, assertRejects } from "@std/assert";
import {
  openrouterKey,
  openrouterModel,
  openrouterModels,
  retryDelay,
  setOpenrouterKey,
  signInUrl,
  validKey,
} from "../src/openrouter.ts";

type Call = { url: string; init: RequestInit };

function stubFetch(
  replies: Response[],
): { calls: Call[]; restore: () => void } {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    const reply = replies.shift();
    if (reply === undefined) throw new Error("no more replies");
    return Promise.resolve(reply);
  }) as typeof fetch;
  return { calls, restore: () => globalThis.fetch = original };
}

const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

Deno.test("an OpenRouter model sends the system and the prompt, with reasoning off, and returns the reply", async () => {
  setOpenrouterKey("sk-or-test");
  const { calls, restore } = stubFetch([
    reply({
      choices: [{ message: { content: '{"action":"answer","text":"4"}' } }],
      usage: { prompt_tokens: 120, completion_tokens: 9 },
    }),
  ]);
  try {
    const model = openrouterModel("vendor/model:free");
    const { text, stats } = await model.generate(
      "SYSTEM",
      "Task: 2+2",
      new AbortController().signal,
    );
    assertEquals(text, '{"action":"answer","text":"4"}');
    assertEquals(stats, { promptTokens: 120, outputTokens: 9 });
    assertEquals(calls.length, 1);
    assertEquals(calls[0].url, "https://openrouter.ai/api/v1/chat/completions");
    const headers = calls[0].init.headers as Record<string, string>;
    assertEquals(headers.authorization, "Bearer sk-or-test");
    const body = JSON.parse(calls[0].init.body as string);
    assertEquals(body.model, "vendor/model:free");
    assertEquals(body.messages, [
      { role: "system", content: "SYSTEM" },
      { role: "user", content: "Task: 2+2" },
    ]);
    assertEquals(body.reasoning, { enabled: false });
  } finally {
    restore();
    setOpenrouterKey(undefined);
  }
});

Deno.test("a rate-limited free model is asked again", async () => {
  setOpenrouterKey("sk-or-test");
  const { calls, restore } = stubFetch([
    reply({ error: { message: "rate-limited" } }, 429),
    reply({ choices: [{ message: { content: "ok" } }] }),
  ]);
  try {
    const { text } = await openrouterModel("m", { retryBaseMs: 1 }).generate(
      "s",
      "p",
      new AbortController().signal,
    );
    assertEquals(text, "ok");
    assertEquals(calls.length, 2);
  } finally {
    restore();
    setOpenrouterKey(undefined);
  }
});

Deno.test("a reply with no text is an error, and a refused key is forgotten", async () => {
  setOpenrouterKey("sk-or-test");
  const { restore } = stubFetch([
    reply({ choices: [{ message: { content: null } }] }),
    reply({ error: { message: "User not found." } }, 401),
  ]);
  try {
    const model = openrouterModel("m");
    const signal = new AbortController().signal;
    await assertRejects(
      () => model.generate("s", "p", signal),
      Error,
      "OpenRouter 200: no reply",
    );
    await assertRejects(
      () => model.generate("s", "p", signal),
      Error,
      "OpenRouter 401: User not found.",
    );
    assertEquals(openrouterKey(), undefined);
    await assertRejects(
      () => model.generate("s", "p", signal),
      Error,
      "not signed in to OpenRouter",
    );
  } finally {
    restore();
    setOpenrouterKey(undefined);
  }
});

Deno.test("the offered models are the list's, saying free or paid", () => {
  const list = [
    { id: "a/free-one:free", label: "Free One" },
    { id: "b/paid-one", label: "Paid One" },
  ];
  assertEquals(
    openrouterModels(list).map((m) => [m.id, m.choice, m.openrouter]),
    [
      [
        "openrouter:a/free-one:free",
        "Free One — OpenRouter, free",
        "a/free-one:free",
      ],
      ["openrouter:b/paid-one", "Paid One — OpenRouter, paid", "b/paid-one"],
    ],
  );
  assertEquals(openrouterModels([]), []);
});

Deno.test("a pasted key must look like one", () => {
  assertEquals(validKey("sk-or-v1-0123456789abcdef"), true);
  assertEquals(validKey("sk-or-v1-0123\n456789"), false);
  assertEquals(validKey("sk-or v1 0123456789"), false);
  assertEquals(validKey("\u201csk-or-v1-0123456789\u201d"), false);
  assertEquals(validKey("short"), false);
});

Deno.test("a reply cut off at the token limit says so", async () => {
  setOpenrouterKey("sk-or-test");
  const { restore } = stubFetch([
    reply({
      choices: [{
        message: { content: '{"action":"wri' },
        finish_reason: "length",
      }],
    }),
  ]);
  try {
    await assertRejects(
      () =>
        openrouterModel("m").generate("s", "p", new AbortController().signal),
      Error,
      "cut off at 4096 tokens",
    );
  } finally {
    restore();
    setOpenrouterKey(undefined);
  }
});

Deno.test("Stop ends a wait between retries at once", async () => {
  setOpenrouterKey("sk-or-test");
  const { calls, restore } = stubFetch([
    new Response("{}", { status: 429, headers: { "retry-after": "10" } }),
  ]);
  try {
    const stop = new AbortController();
    const started = performance.now();
    const asked = openrouterModel("m").generate("s", "p", stop.signal);
    setTimeout(() => stop.abort(new Error("stopped")), 50);
    await assertRejects(() => asked, Error, "stopped");
    assertEquals(performance.now() - started < 2000, true);
    assertEquals(calls.length, 1);
  } finally {
    restore();
    setOpenrouterKey(undefined);
  }
});

Deno.test("a retry waits as Retry-After says, up to 10 s, else backs off", () => {
  assertEquals(retryDelay("3", 0, 2000), 3000);
  assertEquals(retryDelay("0", 2, 2000), 0);
  assertEquals(retryDelay("120", 0, 2000), 10_000);
  assertEquals(retryDelay(null, 0, 2000), 2000);
  assertEquals(retryDelay(null, 2, 2000), 6000);
  assertEquals(retryDelay("soon", 1, 2000), 4000);
});

Deno.test("sign-in comes back to the page without its fragment or an old code", () => {
  const url = new URL(
    signInUrl("https://site.example/?platform=tablet&code=old#agent", "CH"),
  );
  assertEquals(url.origin + url.pathname, "https://openrouter.ai/auth");
  assertEquals(
    url.searchParams.get("callback_url"),
    "https://site.example/?platform=tablet",
  );
  assertEquals(url.searchParams.get("code_challenge"), "CH");
  assertEquals(url.searchParams.get("code_challenge_method"), "S256");
});

Deno.test("a key the storage refuses (full) is kept in memory", () => {
  const setItem = Storage.prototype.setItem;
  Storage.prototype.setItem = () => {
    throw new DOMException("full", "QuotaExceededError");
  };
  try {
    setOpenrouterKey("sk-or-in-memory");
    assertEquals(openrouterKey(), "sk-or-in-memory");
  } finally {
    Storage.prototype.setItem = setItem;
    setOpenrouterKey(undefined);
  }
  assertEquals(openrouterKey(), undefined);
});

Deno.test("a provider error inside a 200 is shown, not taken as a reply", async () => {
  setOpenrouterKey("sk-or-test");
  const { restore } = stubFetch([
    reply({
      choices: [{
        message: { content: "" },
        finish_reason: "error",
        error: { message: "upstream overloaded" },
      }],
    }),
  ]);
  try {
    await assertRejects(
      () =>
        openrouterModel("m").generate("s", "p", new AbortController().signal),
      Error,
      "OpenRouter: upstream overloaded",
    );
  } finally {
    restore();
    setOpenrouterKey(undefined);
  }
});

Deno.test("a rate-limited wait is said on the step's live line", async () => {
  setOpenrouterKey("sk-or-test");
  const { restore } = stubFetch([
    new Response("{}", { status: 429, headers: { "retry-after": "0" } }),
    reply({ choices: [{ message: { content: "ok" } }] }),
  ]);
  try {
    const model = openrouterModel("m");
    const said: string[] = [];
    model.onToken = (t) => said.push(t);
    await model.generate("s", "p", new AbortController().signal);
    assertEquals(said, [
      "\nthe model is busy (rate-limited); asking again in 0 s",
    ]);
  } finally {
    restore();
    setOpenrouterKey(undefined);
  }
});
