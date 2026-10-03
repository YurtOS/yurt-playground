// deno-lint-ignore-file require-await
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { DatasetteDemo, type DatasetteDependencies } from "../src/datasette.ts";
import type { GuestHttpReply } from "../src/guest_http.ts";
const session = "11111111-1111-4111-8111-111111111111";
function json(value: unknown, status = 200): GuestHttpReply {
  return {
    status,
    headers: [["content-type", "application/json"]],
    body: new TextEncoder().encode(JSON.stringify(value)).buffer,
  };
}
function fixture() {
  const exit = Promise.withResolvers<number>();
  const signals: number[] = [];
  const commands: string[] = [];
  let lastSnapshot: unknown;
  let now = 0;
  const deps: DatasetteDependencies = {
    uuid: () => session,
    now: () => now,
    servicePort: 8123,
    delay: async (ms, signal) => {
      signal?.throwIfAborted();
      now += ms;
    },
    spawn: async (line) => {
      commands.push(line);
      return {
        pid: 42,
        exited: exit.promise,
        signalPid: async (s) => {
          signals.push(s);
          exit.resolve(0);
        },
      };
    },
    finite: async (cmd) => {
      commands.push(cmd);
      return {
        code: 0,
        stdout: cmd.includes("server.pid") ? "42\n" : "",
        stderr: "",
      };
    },
    seedSource: async () => new TextEncoder().encode("seed"),
    request: async () => json([{ ready: 1 }]),
    changed: (s) => {
      lastSnapshot = s;
    },
  };
  return {
    deps,
    exit,
    signals,
    commands,
    get snapshot() {
      return lastSnapshot;
    },
    setNow: (v: number) => {
      now = v;
    },
  };
}
Deno.test("Datasette readiness requires final exact JSON shape and correct status", async () => {
  for (
    const reply of [
      json([{ ready: 2 }]),
      json([{ ready: 1, extra: true }]),
      json([{ ready: 1 }], 500),
      {
        ...json([{ ready: 1 }]),
        headers: [["content-type", "text/html"]] as [string, string][],
      },
    ]
  ) {
    const f = fixture();
    f.deps.request = async () => {
      f.setNow(240001);
      return reply;
    };
    const d = new DatasetteDemo(f.deps);
    assertEquals((await d.start()).state, "failed");
    assertEquals(f.signals, [15]);
  }
});
Deno.test("Datasette readiness accepts a validated redirect then exact query result", async () => {
  const f = fixture();
  let count = 0;
  f.deps.request = async (o) => {
    count++;
    assert(o.path.startsWith(`/apps/datasette/${session}/`));
    return count === 1
      ? {
        status: 302,
        headers: [["location", `/apps/datasette/${session}/ready`]],
        body: new ArrayBuffer(0),
      }
      : json([{ ready: 1 }]);
  };
  const d = new DatasetteDemo(f.deps);
  assertEquals((await d.start()).state, "running");
  assert(f.commands.some((command) => command.includes("--port 8123")));
  assertEquals(count, 2);
  await d.stop();
});
Deno.test("Datasette Stop cancels pending Start before waiting for readiness", async () => {
  const f = fixture();
  const reading = Promise.withResolvers<void>();
  const reply = Promise.withResolvers<GuestHttpReply>();
  let cancelled = false;
  f.deps.request = async (o) => {
    o.signal.addEventListener("abort", () => {
      cancelled = true;
    }, { once: true });
    reading.resolve();
    return reply.promise;
  };
  const d = new DatasetteDemo(f.deps);
  const starting = d.start();
  await reading.promise;
  const stopping = d.stop();
  assertEquals(cancelled, true);
  await stopping;
  assertEquals(f.signals, [15]);
  reply.resolve(json([{ ready: 1 }]));
  await starting;
  assertEquals(d.snapshot.state, "stopped");
});
Deno.test("Datasette tracks a stuck resident and forbids reset until its original exit", async () => {
  const f = fixture();
  f.deps.spawn = async () => ({
    pid: 42,
    exited: f.exit.promise,
    signalPid: async (s) => {
      f.signals.push(s);
    },
  });
  const d = new DatasetteDemo(f.deps);
  await d.start();
  assertEquals((await d.stop()).state, "stuck");
  assertEquals(f.signals, [15, 9]);
  const before = f.commands.length;
  await assertRejects(() => d.start());
  await assertRejects(() => d.reset());
  assertEquals(f.commands.length, before);
  f.exit.resolve(0);
  await Promise.resolve();
  await Promise.resolve();
  assertEquals(d.snapshot.state, "stopped");
});
Deno.test("Datasette pid mismatch fails and reports bounded log tail", async () => {
  const f = fixture();
  f.deps.finite = async (cmd) => ({
    code: 0,
    stdout: cmd.includes("exec cat") ? "99" : "log evidence",
    stderr: "",
  });
  const d = new DatasetteDemo(f.deps);
  const s = await d.start();
  assertEquals(s.state, "failed");
  assertStringIncludes(s.error!, "pid");
  assertEquals(s.logTail, "log evidence");
  assertEquals(f.signals, [15]);
});
Deno.test("Datasette early exit invalidates requests and retains failure reason", async () => {
  const f = fixture();
  const d = new DatasetteDemo(f.deps);
  await d.start();
  f.exit.resolve(2);
  await Promise.resolve();
  await Promise.resolve();
  assertEquals(d.snapshot.state, "failed");
  await assertRejects(() =>
    d.request({
      session,
      requestId: "r",
      method: "GET",
      path: `/apps/datasette/${session}/orders`,
      headers: [],
    })
  );
});
Deno.test("Datasette request abort and replacement discard old session", async () => {
  const f = fixture();
  const d = new DatasetteDemo(f.deps);
  await d.start();
  const pending = Promise.withResolvers<void>();
  f.deps.request = async (o) => {
    pending.resolve();
    return new Promise((_, reject) =>
      o.signal.addEventListener("abort", () => reject(o.signal.reason), {
        once: true,
      })
    );
  };
  const req = d.request({
    session,
    requestId: "r",
    method: "GET",
    path: `/apps/datasette/${session}/orders`,
    headers: [],
  });
  await pending.promise;
  d.abort(session, "r");
  await assertRejects(() => req);
  await d.stop();
});
Deno.test("Datasette repeated Stop never re-signals an unconfirmed resident", async () => {
  const f = fixture();
  f.deps.spawn = async () => ({
    pid: 42,
    exited: f.exit.promise,
    signalPid: async (s) => {
      f.signals.push(s);
    },
  });
  const d = new DatasetteDemo(f.deps);
  await d.start();
  await d.stop();
  assertEquals(d.snapshot.state, "stuck");
  await d.stop();
  assertEquals(f.signals, [15, 9]);
  f.exit.resolve(0);
});
Deno.test("Datasette seed failure aborts launch and preserves original diagnostic", async () => {
  const f = fixture();
  let launches = 0;
  f.deps.spawn = async () => {
    launches++;
    throw new Error("must not launch");
  };
  f.deps.seedSource = async () => {
    throw new Error("seed download failed");
  };
  const d = new DatasetteDemo(f.deps);
  const s = await d.start();
  assertEquals(s.state, "failed");
  assertStringIncludes(s.error!, "seed download failed");
  assertEquals(launches, 0);
});
Deno.test("Datasette aborts readiness when the resident exits during startup", async () => {
  const f = fixture();
  const reading = Promise.withResolvers<void>();
  f.deps.request = async () => {
    reading.resolve();
    return new Promise(() => {});
  };
  const d = new DatasetteDemo(f.deps);
  const start = d.start();
  await reading.promise;
  f.exit.resolve(3);
  const s = await start;
  assertEquals(s.state, "failed");
  assertStringIncludes(s.error!, "resident exited");
});
Deno.test("Datasette messages fail closed without qualification and relay guest bytes", async () => {
  const { handleDatasetteMessage } = await import("../src/datasette.ts");
  const messages: unknown[] = [];
  const send = (msg: unknown) => {
    messages.push(msg);
  };
  await handleDatasetteMessage(undefined, {
    type: "datasette-start",
    requestId: "start",
  }, send);
  assertStringIncludes(JSON.stringify(messages.pop()), "qualified");
  const f = fixture();
  const d = new DatasetteDemo(f.deps);
  await d.start();
  await handleDatasetteMessage(d, {
    type: "datasette-http",
    session,
    requestId: "r",
    method: "GET",
    path: `/apps/datasette/${session}/orders`,
    headers: [],
  }, send);
  const msg = messages.pop() as { type: string; body: ArrayBuffer };
  assertEquals(msg.type, "datasette-response");
  assert(msg.body instanceof ArrayBuffer);
  await d.stop();
});
Deno.test("Datasette stale startup diagnostics cannot overwrite Stop", async () => {
  const f = fixture(),
    tail = Promise.withResolvers<
      { code: number; stdout: string; stderr: string }
    >(),
    reading = Promise.withResolvers<void>();
  const finite = f.deps.finite;
  f.deps.request = async () => {
    f.setNow(240001);
    return json([], 500);
  };
  f.deps.finite = async (...args) => {
    if (args[0].includes("tail -c")) {
      reading.resolve();
      return tail.promise;
    }
    return finite(...args);
  };
  const d = new DatasetteDemo(f.deps), starting = d.start();
  await reading.promise;
  await d.stop();
  tail.resolve({ code: 0, stdout: "old log", stderr: "" });
  await starting;
  assertEquals(d.snapshot.state, "stopped");
});
Deno.test("Datasette Stop cancels a stalled seed before spawning a resident", async () => {
  const f = fixture(),
    reading = Promise.withResolvers<void>(),
    seed = Promise.withResolvers<Uint8Array>();
  f.deps.seedSource = async () => {
    reading.resolve();
    return seed.promise;
  };
  const d = new DatasetteDemo(f.deps), starting = d.start();
  await reading.promise;
  const timeout = Promise.withResolvers<never>();
  const timer = setTimeout(
    () => timeout.reject(new Error("Stop waited for seed")),
    50,
  );
  const result = await Promise.race([d.stop(), timeout.promise]).finally(() =>
    clearTimeout(timer)
  );
  assertEquals(result.state, "stopped");
  await starting;
  assertEquals(f.signals, []);
});
Deno.test("Datasette reset keeps Start disabled until the seed transaction finishes", async () => {
  const f = fixture(),
    ready = Promise.withResolvers<void>(),
    reset = Promise.withResolvers<
      { code: number; stdout: string; stderr: string }
    >();
  const finite = f.deps.finite;
  f.deps.finite = async (...args) => {
    if (args[0].endsWith("--reset")) {
      ready.resolve();
      return reset.promise;
    }
    return finite(...args);
  };
  const d = new DatasetteDemo(f.deps);
  await d.start();
  const resetting = d.reset();
  await ready.promise;
  assertEquals(d.snapshot.state, "stopping");
  await assertRejects(() => d.start());
  reset.resolve({ code: 0, stdout: "", stderr: "" });
  await resetting;
  assertEquals(d.snapshot.state, "stopped");
});
Deno.test("Datasette never publishes stopped before a reset's seed finishes", async () => {
  const f = fixture(),
    ready = Promise.withResolvers<void>(),
    reset = Promise.withResolvers<
      { code: number; stdout: string; stderr: string }
    >();
  const finite = f.deps.finite, states: string[] = [];
  f.deps.finite = async (...args) => {
    if (args[0].endsWith("--reset")) {
      ready.resolve();
      return reset.promise;
    }
    return finite(...args);
  };
  const changed = f.deps.changed;
  f.deps.changed = (s) => {
    states.push(s.state);
    changed(s);
  };
  const d = new DatasetteDemo(f.deps);
  await d.start();
  states.length = 0;
  const resetting = d.reset();
  await ready.promise;
  // The resident's exit lands while the reset is stopping; Start must stay
  // disabled until the seed is replaced, or its generation bump aborts it.
  assertEquals(states.includes("stopped"), false, states.join());
  reset.resolve({ code: 0, stdout: "", stderr: "" });
  await resetting;
  assertEquals(states.at(-1), "stopped");
});
Deno.test("Datasette concurrent Start shares one launch and log failure keeps the original reason", async () => {
  const f = fixture(),
    probe = Promise.withResolvers<GuestHttpReply>(),
    reading = Promise.withResolvers<void>();
  let launches = 0;
  const launch = f.deps.spawn;
  f.deps.spawn = async (line) => {
    launches++;
    return launch(line);
  };
  f.deps.request = async () => {
    reading.resolve();
    return probe.promise;
  };
  const d = new DatasetteDemo(f.deps), first = d.start();
  assertEquals(d.start(), first);
  await reading.promise;
  probe.resolve(json([{ ready: 1 }]));
  await first;
  assertEquals(launches, 1);
  await d.stop();
  const failed = fixture(), finite = failed.deps.finite;
  failed.deps.request = async () => {
    failed.setNow(240001);
    return json([], 500);
  };
  failed.deps.finite = async (...args) =>
    args[0].includes("tail -c")
      ? { code: 1, stdout: "", stderr: "missing log" }
      : finite(...args);
  const result = await new DatasetteDemo(failed.deps).start();
  assertStringIncludes(result.error!, "readiness timed out");
  assertStringIncludes(result.logTail!, "missing log");
});
Deno.test("Datasette reset failure publishes failed internally and permits retry", async () => {
  for (const failSeed of [true, false]) {
    const f = fixture(), seed = f.deps.seedSource, finite = f.deps.finite;
    if (failSeed) {
      f.deps.seedSource = async () => {
        throw new Error("seed download failed");
      };
    } else {f.deps.finite = async (...args) =>
        args[0].endsWith("--reset")
          ? { code: 1, stdout: "", stderr: "reset failed" }
          : finite(...args);}
    const d = new DatasetteDemo(f.deps);
    await assertRejects(() => d.reset());
    assertEquals(d.snapshot.state, "failed");
    f.deps.seedSource = seed;
    f.deps.finite = finite;
    assertEquals((await d.reset()).state, "stopped");
    assertEquals((await d.start()).state, "running");
    await d.stop();
  }
});
