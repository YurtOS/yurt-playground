// deno-lint-ignore-file require-await
import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
  GuestApp,
  type GuestAppDependencies,
  type GuestAppSpec,
} from "../src/guest_app.ts";
import { cachedFetch } from "../src/datasette.ts";

const session = "11111111-1111-4111-8111-111111111111";
const bytes = (value: string) => new TextEncoder().encode(value);

function fixture() {
  const commands: string[] = [];
  const exited = Promise.withResolvers<number>();
  const spec: GuestAppSpec = {
    id: "preview",
    title: "Preview",
    dir: "/tmp/preview",
    prepare: async (ctx) => {
      await ctx.finite("prepare preview");
    },
    reset: async () => {},
    spawnLine: (prefix, port) => `exec preview --base ${prefix} --port ${port}`,
    readyPath: (prefix) => prefix + "ready",
    isReady: (reply) => reply.status === 204,
  };
  const deps: GuestAppDependencies = {
    uuid: () => session,
    now: () => 0,
    servicePort: 8002,
    delay: async () => {},
    spawn: async (line) => {
      commands.push(line);
      return {
        pid: 42,
        exited: exited.promise,
        signalPid: async () => exited.resolve(0),
      };
    },
    finite: async (line) => {
      commands.push(line);
      return {
        code: 0,
        stdout: line.includes("exec cat") ? "42" : "",
        stderr: "",
      };
    },
    asset: async () => bytes("asset"),
    request: async (options) => {
      assertEquals(options.app, "preview");
      assertEquals(options.path, `/apps/preview/${session}/ready`);
      return { status: 204, headers: [], body: new ArrayBuffer(0) };
    },
    portBusy: async () => false,
    changed: () => {},
  };
  return { commands, deps, spec };
}

Deno.test("GuestApp prepares before spawning and wraps the spec command with pid and log", async () => {
  const { commands, deps, spec } = fixture();
  const app = new GuestApp(spec, deps);
  assertEquals((await app.start()).state, "running");
  assertEquals(commands[0], "prepare preview");
  assertStringIncludes(
    commands[1],
    "echo $$ > '/tmp/preview/server.pid' && exec preview",
  );
  assertStringIncludes(
    commands[1],
    "--port 8002 > '/tmp/preview/server.log' 2>&1",
  );
  await app.stop();
});

Deno.test("GuestApp refuses a busy service port before spawning", async () => {
  const { commands, deps, spec } = fixture();
  deps.portBusy = async () => true;
  const app = new GuestApp(spec, deps);
  const result = await app.start();
  assertEquals(result.state, "failed");
  assertStringIncludes(result.error!, "in use");
  assertEquals(
    commands.some((command) => command.includes("exec preview")),
    false,
  );
});
Deno.test("GuestApp skips an asset requested after Start is stopped", async () => {
  const { deps, spec } = fixture();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const finite = deps.finite;
  deps.finite = async (...args) => {
    if (args[0] === "prepare preview") {
      entered.resolve();
      await release.promise;
    }
    return finite(...args);
  };
  let assetCalls = 0;
  deps.asset = async () => {
    assetCalls++;
    return bytes("asset");
  };
  spec.prepare = async (ctx) => {
    await ctx.finite("prepare preview");
    await ctx.asset("preview.py");
  };
  const app = new GuestApp(spec, deps);
  const starting = app.start();
  await entered.promise;
  const stopping = app.stop();
  release.resolve();
  await Promise.all([starting, stopping]);
  assertEquals(assetCalls, 0);
  assertEquals(app.snapshot.state, "stopped");
});

Deno.test("cachedFetch keys successful assets by name and reuses bytes", async () => {
  const original = globalThis.fetch;
  const seen: string[] = [];
  globalThis.fetch = async (input) => {
    seen.push(String(input));
    return new Response(bytes(String(input)));
  };
  try {
    const cache = new Map<string, Uint8Array>();
    const signal = new AbortController().signal;
    const first = await cachedFetch(cache, "first.py", signal);
    const second = await cachedFetch(cache, "second.py", signal);
    assertEquals(new TextDecoder().decode(first), "/demo/first.py");
    assertEquals(new TextDecoder().decode(second), "/demo/second.py");
    assertEquals(await cachedFetch(cache, "first.py", signal), first);
    assertEquals(seen, ["/demo/first.py", "/demo/second.py"]);
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("cachedFetch does not cache failed, oversized, or aborted downloads", async () => {
  const original = globalThis.fetch;
  const cache = new Map<string, Uint8Array>();
  let calls = 0;
  const aborting = new AbortController();
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) return new Response("missing", { status: 404 });
    if (calls === 2) return new Response(new Uint8Array(65 * 1024));
    if (calls === 3) {
      aborting.abort();
      return new Response(bytes("aborted"));
    }
    return new Response(bytes("ok"));
  };
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      await assertRejects(() =>
        cachedFetch(
          cache,
          "retry.py",
          attempt === 2 ? aborting.signal : new AbortController().signal,
        )
      );
      assertEquals(cache.has("retry.py"), false);
    }
    assertEquals(
      new TextDecoder().decode(
        await cachedFetch(cache, "retry.py", new AbortController().signal),
      ),
      "ok",
    );
    assertEquals(calls, 4);
  } finally {
    globalThis.fetch = original;
  }
});
