// deno-lint-ignore-file require-await
import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
  GuestApp,
  type GuestAppDependencies,
  type GuestAppSpec,
} from "../src/guest_app.ts";
import { ByteBudget, SlotQueue } from "../src/slot_queue.ts";
import type { GuestHttpOptions } from "../src/guest_http.ts";
import type { GuestAppId } from "../src/guest_apps.ts";
import type { BrowserPlaygroundSession } from "../src/boot.ts";
import type { ExecutionRegistry } from "../src/executions.ts";
import type { Pins } from "../src/pins.ts";
import { GuestHttpError } from "../src/guest_http.ts";
import * as dispatch from "../src/datasette.ts";
import { cachedFetch } from "../src/datasette.ts";

const session = "11111111-1111-4111-8111-111111111111";
const bytes = (value: string) => new TextEncoder().encode(value);

function fixture(id: GuestAppId = "preview", owner = session) {
  const commands: string[] = [];
  const exited = Promise.withResolvers<number>();
  const spec: GuestAppSpec = {
    id,
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
    queue: new SlotQueue(),
    uuid: () => owner,
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
      assertEquals(options.app, id);
      assertEquals(options.path, `/apps/${id}/${owner}/ready`);
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

const prefix = `/apps/preview/${session}/`;
const req = (requestId: string, body?: ArrayBuffer) => ({
  session,
  requestId,
  method: "POST" as const,
  path: prefix + requestId,
  headers: [] as [string, string][],
  body,
});
const ok = () => ({
  status: 200,
  headers: [] as [string, string][],
  body: new ArrayBuffer(0),
});
async function running() {
  const f = fixture();
  const app = new GuestApp(f.spec, f.deps);
  await app.start();
  return { ...f, app };
}
Deno.test("GuestApp stores, strips and replays Set-Cookie", async () => {
  const { app, deps } = await running();
  const seen: GuestHttpOptions[] = [];
  deps.request = async (o) => {
    seen.push(o);
    return { ...ok(), setCookies: ["sid=1; Path=" + prefix] };
  };
  try {
    assertEquals((await app.request(req("login"))).setCookies, undefined);
    await app.request(req("home"));
    assertEquals(seen.map((o) => o.cookie), [undefined, "sid=1"]);
  } finally {
    await app.stop();
  }
});
Deno.test("GuestApp queues bursts with at most four active requests", async () => {
  const { app, deps } = await running();
  let active = 0, peak = 0;
  deps.request = async () => {
    peak = Math.max(peak, ++active);
    await new Promise((resolve) => setTimeout(resolve, 0));
    --active;
    return ok();
  };
  try {
    assertEquals(
      (await Promise.all(
        Array.from({ length: 20 }, (_, i) => app.request(req(String(i)))),
      )).length,
      20,
    );
    assertEquals(peak, 4);
  } finally {
    await app.stop();
  }
});
Deno.test("GuestApp Stop promptly aborts queued requests without dialing them", async () => {
  const { app, deps } = await running();
  let dials = 0;
  deps.request = async () => {
    dials++;
    return new Promise(() => {});
  };
  const pending = Array.from(
    { length: 7 },
    (_, i) => app.request(req(String(i))),
  );
  const rejected = pending.map((p) => assertRejects(() => p, DOMException));
  await new Promise((resolve) => setTimeout(resolve, 0));
  await app.stop();
  await Promise.all(rejected);
  assertEquals(dials, 4);
});
Deno.test("GuestApp reserves queued uploads, frees aborts and preserves other reservations", async () => {
  const { app, deps } = await running();
  deps.request = async () => new Promise(() => {});
  deps.queue = new SlotQueue({
    perSession: 1,
    global: 1,
    maxWaiting: 64,
    waitMs: 30000,
  });
  const unblock = await deps.queue.acquire(session);
  // Use the real 64 MiB session cap, without adding a production budget knob.
  const upload = new ArrayBuffer(16 * 1024 * 1024);
  const pending = Array.from(
    { length: 4 },
    (_, i) => app.request(req(String(i), upload)),
  );
  const rejected = pending.map((p) => assertRejects(() => p, DOMException));
  try {
    const error = await assertRejects(
      () => app.request(req("overflow", new ArrayBuffer(1))),
      GuestHttpError,
    );
    assertEquals(error.status, 503);
    app.abort(session, "0");
    await rejected[0];
    const replacement = app.request(req("replacement", upload));
    const replacementRejected = assertRejects(() => replacement, DOMException);
    await assertRejects(
      () => app.request(req("still-full", new ArrayBuffer(1))),
      GuestHttpError,
    );
    await app.stop();
    await Promise.all([...rejected, replacementRejected]);
  } finally {
    unblock();
    await app.stop();
  }
});
Deno.test("GuestApp returns exact reservations on success, read failure, limit failure and abort", async () => {
  const { app, deps } = await running();
  const originalTake = ByteBudget.prototype.take,
    originalGive = ByteBudget.prototype.give;
  let used = 0;
  ByteBudget.prototype.take = function (n) {
    originalTake.call(this, n);
    used += n;
  };
  ByteBudget.prototype.give = function (n) {
    originalGive.call(this, n);
    used -= n;
  };
  try {
    const entered = Promise.withResolvers<void>();
    deps.request = async (o) => {
      o.onBuffer?.(11);
      if (o.path.endsWith("hold")) {
        entered.resolve();
        return new Promise(() => {});
      }
      if (o.path.endsWith("fail")) throw new Error("read failed");
      if (o.path.endsWith("limit")) o.onBuffer?.(64 * 1024 * 1024);
      return ok();
    };
    const hold = app.request(req("hold", new ArrayBuffer(7)));
    const aborted = assertRejects(() => hold, DOMException);
    await entered.promise;
    assertEquals(used, 18);
    await app.request(req("ok", new ArrayBuffer(5)));
    assertEquals(used, 18);
    await assertRejects(
      () => app.request(req("fail", new ArrayBuffer(5))),
      Error,
      "read failed",
    );
    assertEquals(used, 18);
    await assertRejects(
      () => app.request(req("limit", new ArrayBuffer(5))),
      GuestHttpError,
    );
    assertEquals(used, 18);
    app.abort(session, "hold");
    await aborted;
    assertEquals(used, 0);
  } finally {
    try {
      await app.stop();
    } finally {
      ByteBudget.prototype.take = originalTake;
      ByteBudget.prototype.give = originalGive;
    }
  }
});
Deno.test("Guest app dispatcher routes Preview requests and session-owned aborts", async () => {
  const { app, deps } = await running();
  const otherSession = "22222222-2222-4222-8222-222222222222";
  const other = fixture("datasette", otherSession);
  const a = new GuestApp(other.spec, other.deps);
  await a.start();
  const apps = new Map([["preview" as const, app], ["datasette" as const, a]]);
  const sent: Record<string, unknown>[] = [];
  const send = (reply: unknown) => {
    sent.push(reply as Record<string, unknown>);
  };
  deps.request = async () => ok();
  try {
    assertEquals(
      await dispatch.handleGuestAppMessage(apps, {
        type: "datasette-http",
        app: "preview",
        ...req("ok"),
      }, send),
      true,
    );
    assertEquals([sent[0].session, sent[0].requestId, "app" in sent[0]], [
      session,
      "ok",
      false,
    ]);
    const entered = Promise.withResolvers<void>();
    let aborted = false;
    deps.request = async (o) => {
      o.signal.addEventListener("abort", () => {
        aborted = true;
      });
      entered.resolve();
      return new Promise(() => {});
    };
    const pending = dispatch.handleGuestAppMessage(apps, {
      type: "datasette-http",
      app: "preview",
      ...req("slow"),
    }, send);
    await entered.promise;
    await dispatch.handleGuestAppMessage(apps, {
      type: "datasette-abort",
      session: "22222222-2222-4222-8222-222222222222",
      requestId: "slow",
    }, send);
    assertEquals(aborted, false);
    await dispatch.handleGuestAppMessage(apps, {
      type: "datasette-abort",
      session,
      requestId: "slow",
    }, send);
    await pending;
    assertEquals(sent.at(-1)?.type, "datasette-error");
    assertEquals(sent.at(-1)?.code, 503);
  } finally {
    await app.stop();
    await a.stop();
  }
});
Deno.test("port ownership recognizes only ECONNREFUSED as free", () => {
  assertEquals(
    dispatch.isConnRefused(new Error("dialSandboxPort connect: rc=-111")),
    true,
  );
  for (const message of ["rc=-110", "x", "rc=-1110"]) {
    assertEquals(dispatch.isConnRefused(new Error(message)), false);
  }
});

Deno.test("GuestApp clears cookies on Stop, Reset and resident exit", async () => {
  for (const end of ["stop", "reset", "exit"] as const) {
    const { spec, deps } = fixture();
    let exited = Promise.withResolvers<number>();
    deps.spawn = async () => {
      exited = Promise.withResolvers<number>();
      return {
        pid: 42,
        exited: exited.promise,
        signalPid: async () => exited.resolve(0),
      };
    };
    // Keep the same UUID in the fixture so path scoping cannot hide stale cookies.
    const app = new GuestApp(spec, deps);
    const ready = deps.request;
    await app.start();
    deps.request = async () => ({ ...ok(), setCookies: ["sid=1; Path=/"] });
    await app.request(req("login"));
    if (end === "exit") {
      exited.resolve(1);
      await Promise.resolve();
    } else await app[end]();
    deps.request = ready;
    await app.start();
    let cookie: string | undefined;
    deps.request = async (o) => {
      cookie = o.cookie;
      return ok();
    };
    try {
      await app.request(req("home"));
      assertEquals(cookie, undefined, end);
    } finally {
      await app.stop();
    }
  }
});
Deno.test("attachment closes an occupied port and fails start; non-refusal errors fail start", async () => {
  const pins = { datasette: { inlineScriptHashes: [] } } as unknown as Pins;
  for (const failure of [undefined, new Error("connect rc=-110")]) {
    let closes = 0;
    const ports: number[] = [];
    const session = {
      guestPorts: { datasette: 8001, preview: 8002 },
      dialSandboxPort: (port: number) => {
        ports.push(port);
        if (failure) throw failure;
        return {
          close: () => {
            closes++;
          },
        };
      },
      spawn: () => {
        throw new Error("occupied port must not spawn");
      },
    } as unknown as BrowserPlaygroundSession;
    const executions = {
      spawn: async () => "id",
      wait: async () => ({ code: 0, stdout: "", stderr: "" }),
    } as unknown as ExecutionRegistry;
    const fetch = globalThis.fetch;
    globalThis.fetch = async () => new Response("seed");
    try {
      const apps = dispatch.attachGuestApps(session, pins, {
        executions,
        send: () => {},
      });
      const result = await apps.get("datasette")!.start();
      assertEquals(result.state, "failed");
      assertStringIncludes(result.error!, failure ? "rc=-110" : "in use");
      assertEquals(ports, [8001]);
      assertEquals(closes, failure ? 0 : 1);
    } finally {
      globalThis.fetch = fetch;
    }
  }
});

Deno.test("late cancelled queue cleanup releases its original session budget", async () => {
  const { app, deps } = await running();
  const originalTake = ByteBudget.prototype.take;
  const originalGive = ByteBudget.prototype.give;
  const used = new Map<ByteBudget, number>();
  ByteBudget.prototype.take = function (n) {
    originalTake.call(this, n);
    used.set(this, (used.get(this) ?? 0) + n);
  };
  ByteBudget.prototype.give = function (n) {
    originalGive.call(this, n);
    used.set(this, (used.get(this) ?? 0) - n);
  };
  const grant = Promise.withResolvers<() => void>();
  const acquire = deps.queue.acquire.bind(deps.queue);
  deps.queue.acquire = () => grant.promise;
  const old = app.request(req("old", new ArrayBuffer(7)));
  const oldRejected = assertRejects(() => old, DOMException);
  try {
    const oldBudget = [...used.keys()][0];
    await app.stop();
    deps.queue.acquire = acquire;
    const exit = Promise.withResolvers<number>();
    deps.spawn = async () => ({
      pid: 42,
      exited: exit.promise,
      signalPid: async () => exit.resolve(0),
    });
    await app.start();
    const entered = Promise.withResolvers<void>();
    deps.request = async (o) => {
      o.onBuffer?.(11);
      entered.resolve();
      return new Promise(() => {});
    };
    const current = app.request(req("current", new ArrayBuffer(13)));
    const currentRejected = assertRejects(() => current, DOMException);
    await entered.promise;
    const currentBudget = [...used.keys()].find((b) => b !== oldBudget)!;
    assertEquals(used.get(currentBudget), 24);
    grant.resolve(() => {});
    await oldRejected;
    assertEquals(used.get(oldBudget), 0);
    assertEquals(used.get(currentBudget), 24);
    app.abort(session, "current");
    await currentRejected;
    assertEquals([...used.values()], [0, 0]);
  } finally {
    grant.resolve(() => {});
    try {
      await app.stop();
      await oldRejected;
    } finally {
      ByteBudget.prototype.take = originalTake;
      ByteBudget.prototype.give = originalGive;
    }
  }
});

Deno.test("attached HTTP pins both the dial and wire Host to its captured service port", async () => {
  const ports: number[] = [];
  let written = "";
  const wire = bytes("HTTP/1.1 204 No Content\r\n\r\n");
  let offset = 0;
  const guestPorts = { datasette: 8001, preview: 8002 };
  const browser = {
    guestPorts,
    dialSandboxPort: (port: number) => {
      ports.push(port);
      return {
        read: async (n: number) => {
          const part = wire.slice(offset, offset + n);
          offset += part.length;
          return part;
        },
        write: async (part: Uint8Array) => {
          written += new TextDecoder().decode(part);
        },
        close: async () => {},
      };
    },
  } as unknown as BrowserPlaygroundSession;
  const pins = { datasette: { inlineScriptHashes: [] } } as unknown as Pins;
  const app = dispatch.attachGuestApps(browser, pins, {
    executions: {} as ExecutionRegistry,
    send: () => {},
  }).get("datasette")!;
  guestPorts.datasette = 9999;
  await app.deps.request({
    app: "datasette",
    session,
    prefix: `/apps/datasette/${session}/`,
    path: `/apps/datasette/${session}/`,
    method: "GET",
    headers: [],
    signal: new AbortController().signal,
    port: 9000,
  });
  assertEquals(ports, [8001]);
  assertStringIncludes(written, "Host: 127.0.0.1:8001\r\n");
});
