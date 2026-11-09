import { assertEquals, assertRejects } from "@std/assert";
import {
  openrouterKey,
  openrouterModel,
  openrouterModels,
  OpenrouterSignedOut,
  retryDelay,
  setOpenrouterKey,
  signInUrl,
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
      OpenrouterSignedOut,
      "OpenRouter 401: User not found.",
    );
    assertEquals(openrouterKey(), undefined);
    await assertRejects(
      () => model.generate("s", "p", signal),
      OpenrouterSignedOut,
      "not signed in to OpenRouter",
    );
  } finally {
    restore();
    setOpenrouterKey(undefined);
  }
});

Deno.test("the offered models say free or paid, and ?model= can add another", () => {
  const list = [
    { id: "a/free-one:free", label: "Free One" },
    { id: "b/paid-one", label: "Paid One" },
  ];
  const models = openrouterModels(list);
  assertEquals(models.map((m) => [m.id, m.choice, m.openrouter]), [
    [
      "openrouter:a/free-one:free",
      "Free One — OpenRouter, free",
      "a/free-one:free",
    ],
    ["openrouter:b/paid-one", "Paid One — OpenRouter, paid", "b/paid-one"],
  ]);
  const extra = openrouterModels(list, "vendor/other");
  assertEquals(extra.map((m) => m.id), [
    "openrouter:vendor/other",
    "openrouter:a/free-one:free",
    "openrouter:b/paid-one",
  ]);
  assertEquals(openrouterModels(list, "b/paid-one").length, 2);
  assertEquals(openrouterModels([]), []);
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
