import { assertEquals, assertRejects } from "@std/assert";
import {
  openrouterKey,
  openrouterModel,
  openrouterModels,
  setOpenrouterKey,
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
    const { text } = await openrouterModel("m").generate(
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

Deno.test("the offered models say free or paid, and ?model= can add another", () => {
  const models = openrouterModels();
  const ids = models.map((m) => m.id);
  assertEquals(ids.every((id) => id.startsWith("openrouter:")), true);
  for (const m of models) {
    assertEquals(
      m.choice.endsWith(m.id.endsWith(":free") ? "free" : "paid"),
      true,
      m.choice,
    );
  }
  const extra = openrouterModels("vendor/other");
  assertEquals(extra[0].id, "openrouter:vendor/other");
  assertEquals(extra.length, ids.length + 1);
});
