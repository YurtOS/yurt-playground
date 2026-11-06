/**
 * The Ollama client against a local stand-in speaking its HTTP API. The real
 * server, in real Chrome, is tests/agent_ollama_e2e.ts (a Mac, not CI).
 */
import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { parseAction, systemPrompt } from "../src/agent.ts";
import {
  ACTION_SCHEMA,
  firstObject,
  listOllamaModels,
  OLLAMA_CONTEXT_TOKENS,
  OLLAMA_LIMITS,
  OLLAMA_MAX_OUTPUT_TOKENS,
  ollamaHelp,
  ollamaModel,
} from "../src/ollama.ts";

async function withServer(
  handler: (request: Request) => Response | Promise<Response>,
  body: (base: string) => Promise<void>,
): Promise<void> {
  const server = Deno.serve(
    { port: 0, hostname: "127.0.0.1", onListen: () => {} },
    handler,
  );
  try {
    await body(`http://127.0.0.1:${server.addr.port}`);
  } finally {
    await server.shutdown();
  }
}

const never = new AbortController().signal;

/** A reply cut at the given byte offsets, as a network may cut it. */
function chunked(text: string, cuts: number[]): Response {
  const bytes = new TextEncoder().encode(text);
  const ends = [...cuts, bytes.length];
  let from = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      const to = ends.shift()!;
      controller.enqueue(bytes.slice(from, to));
      from = to;
      if (ends.length === 0) controller.close();
    },
  });
  return new Response(stream);
}

const REPLY = [
  { message: { content: '{"action":"answer",' } },
  { message: { content: '"text":"é"}' } },
  { message: { content: "" }, done: true, prompt_eval_count: 7, eval_count: 2 },
].map((l) => JSON.stringify(l)).join("\n") + "\n";

Deno.test("a reply assembles across any cut, and tokens stream in order", async () => {
  const bytes = new TextEncoder().encode(REPLY).length;
  // Every cut, including through the two bytes of "é".
  for (let cut = 1; cut < bytes; cut += 3) {
    await withServer(() => chunked(REPLY, [cut]), async (base) => {
      const llm = ollamaModel(() => "m", base);
      const tokens: string[] = [];
      llm.onToken = (t) => tokens.push(t);
      const { text, stats } = await llm.generate("s", "p", never);
      assertEquals(text, '{"action":"answer","text":"é"}');
      assertEquals(tokens.join(""), text);
      assertEquals(stats, { promptTokens: 7, outputTokens: 2 });
      assertEquals(llm.lastStats, stats);
      assertEquals(parseAction(text), { action: "answer", text: "é" });
    });
  }
});

Deno.test("the request names the model of the moment, the prompts and the action schema", async () => {
  const seen: Record<string, unknown>[] = [];
  await withServer(async (request) => {
    assertEquals(new URL(request.url).pathname, "/api/chat");
    assertEquals(request.method, "POST");
    seen.push(await request.json());
    return chunked(REPLY, []);
  }, async (base) => {
    let name = "first";
    const llm = ollamaModel(() => name, base);
    await llm.generate("the system", "the prompt", never);
    name = "second";
    await llm.generate("the system", "the prompt", never);
  });
  assertEquals(seen.map((b) => b.model), ["first", "second"]);
  assertEquals(seen[0].messages, [
    { role: "system", content: "the system" },
    { role: "user", content: "the prompt" },
  ]);
  assertEquals(seen[0].format, ACTION_SCHEMA);
  assertEquals(seen[0].think, false);
  assertEquals(
    (seen[0].options as { num_ctx: number }).num_ctx,
    OLLAMA_CONTEXT_TOKENS,
  );
});

Deno.test("Ollama's own error reaches the caller, whole or mid-stream", async () => {
  await withServer(
    () => Response.json({ error: "model 'x' not found" }, { status: 404 }),
    (base) =>
      assertRejects(
        () => ollamaModel(() => "x", base).generate("s", "p", never),
        Error,
        "model 'x' not found",
      ).then(() => {}),
  );
  await withServer(
    () => new Response("not json", { status: 500 }),
    (base) =>
      assertRejects(
        () => ollamaModel(() => "x", base).generate("s", "p", never),
        Error,
        "Ollama answered 500",
      ).then(() => {}),
  );
  await withServer(
    () => chunked('{"error":"out of memory"}\n', []),
    (base) =>
      assertRejects(
        () => ollamaModel(() => "x", base).generate("s", "p", never),
        Error,
        "out of memory",
      ).then(() => {}),
  );
});

Deno.test("a reply that ends with no done line is a failure, not an answer", async () => {
  await withServer(
    () => chunked('{"message":{"content":"{\\"action\\":"}}\n', []),
    (base) =>
      assertRejects(
        () => ollamaModel(() => "x", base).generate("s", "p", never),
        Error,
        "ended early",
      ).then(() => {}),
  );
});

Deno.test("abort closes the request, so Ollama stops generating", async () => {
  const closed = Promise.withResolvers<void>();
  await withServer(async (request) => {
    await request.text();
    let stream: ReadableStreamDefaultController<Uint8Array>;
    request.signal.addEventListener("abort", () => {
      closed.resolve();
      stream.close();
    });
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          stream = controller;
          controller.enqueue(
            new TextEncoder().encode('{"message":{"content":"x"}}\n'),
          );
        },
      }),
    );
  }, async (base) => {
    const abort = new AbortController();
    const llm = ollamaModel(() => "x", base);
    // Mid-reply, as the Stop button does it.
    llm.onToken = () => abort.abort();
    await assertRejects(() => llm.generate("s", "p", abort.signal));
    await closed.promise;
  });
});

Deno.test("the installed models are listed by name", async () => {
  await withServer(() =>
    Response.json({
      models: [{ name: "gemma4:e4b", size: 1 }, { name: "llama3.2:3b" }],
    }), async (base) => {
    assertEquals(await listOllamaModels(base), ["gemma4:e4b", "llama3.2:3b"]);
  });
  await withServer(
    () => new Response("no", { status: 403 }),
    (base) =>
      assertRejects(() => listOllamaModels(base), Error, "403").then(() => {}),
  );
});

Deno.test("the help names the origin to allow and the browser's question", () => {
  const help = ollamaHelp("https://example.dev");
  assertStringIncludes(help, "OLLAMA_ORIGINS=https://example.dev ollama");
  assertStringIncludes(help, "local network");
  assertStringIncludes(help, "quit it first");
});

Deno.test("the limits fit the context window at the densest measured rate", () => {
  // Hex output: about 2 characters a token. A full prompt, the system prompt
  // and a full reply must all fit.
  const tokens = (chars: number) => Math.ceil(chars / 2);
  const total = tokens(OLLAMA_LIMITS.maxPrompt) +
    tokens(systemPrompt(true).length) + OLLAMA_MAX_OUTPUT_TOKENS;
  assertEquals(total < OLLAMA_CONTEXT_TOKENS, true, `${total} tokens`);
});

Deno.test("cloud models are not listed: their prompts leave this computer", async () => {
  await withServer(() =>
    Response.json({
      models: [
        { name: "gemma4:e4b" },
        { name: "gpt-oss:20b-cloud" },
        { name: "kimi:cloud" },
      ],
    }), async (base) => {
    assertEquals(await listOllamaModels(base), ["gemma4:e4b"]);
  });
});

Deno.test("a server that accepts and never answers ends the wait", async () => {
  const release = Promise.withResolvers<void>();
  await withServer(async () => {
    await release.promise;
    return new Response("late");
  }, async (base) => {
    await assertRejects(() => listOllamaModels(base, 50));
    release.resolve();
  });
});

Deno.test("only the first object of a reply that lists its plan is the action", () => {
  const first = '{"action":"exec","cmd":"echo \\"}\\" {"}';
  assertEquals(firstObject(`${first}\n{"action":"answer","text":"x"}`), first);
  assertEquals(firstObject(`  ${first}`), first);
  assertEquals(firstObject(first), first);
  // Not this function's to rescue: the controller refuses these.
  assertEquals(firstObject("Sure! {}"), "Sure! {}");
  assertEquals(firstObject('{"a":'), '{"a":');
  assertEquals(firstObject("no json"), "no json");
  assertEquals(parseAction(firstObject(`${first}\n{"x":1}`)), {
    action: "exec",
    cmd: 'echo "}" {',
  });
});
