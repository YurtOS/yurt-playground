import { assertEquals, assertRejects } from "@std/assert";
import type { Yurt } from "../src/agent_api.ts";
import { createAgentTools, waitForSandbox } from "../src/agent_tools.ts";

function sandbox(spawn: Yurt["spawn"]): Yurt {
  return { spawn } as unknown as Yurt;
}

Deno.test("Stop during sandbox spawn kills the process when it appears", async () => {
  let resolveSpawn!: (execution: Awaited<ReturnType<Yurt["spawn"]>>) => void;
  let kills = 0;
  const tools = createAgentTools(sandbox(() =>
    new Promise((resolve) => {
      resolveSpawn = resolve;
    })
  ));
  const controller = new AbortController();
  const result = tools.exec("sleep 60", controller.signal);

  controller.abort();
  resolveSpawn({
    id: "sleep",
    kill: () => {
      kills++;
      return Promise.resolve();
    },
    wait: () =>
      Promise.resolve({
        code: null,
        signal: "SIGTERM",
        timedOut: false,
        stdout: "",
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
      }),
  });

  await assertRejects(() => result, Error, "cancelled");
  assertEquals(kills, 1);
});

Deno.test("exec preserves nonzero exit results and the default output limit", async () => {
  const tools = createAgentTools(sandbox((_cmd, opts) => {
    assertEquals(opts?.maxOutputBytes, 1024 * 1024);
    return Promise.resolve({
      id: "command",
      kill: () => Promise.resolve(),
      wait: () =>
        Promise.resolve({
          code: 7,
          signal: null,
          timedOut: false,
          stdout: "partial",
          stderr: "failure",
          stdoutTruncated: false,
          stderrTruncated: false,
        }),
    });
  }));
  const result = await tools.exec("false", new AbortController().signal);
  assertEquals(result, {
    code: 7,
    stdout: "partial",
    stderr: "failure",
  });
});

Deno.test("Stop kills and settles a file read process", async () => {
  let resolveWait!: (value: never) => void;
  let waitStarted!: () => void;
  const waiting = new Promise<void>((resolve) => waitStarted = resolve);
  let kills = 0;
  const tools = createAgentTools(sandbox((cmd, opts) => {
    assertEquals(cmd, "cat -- '/tmp/a file'");
    assertEquals(opts?.maxOutputBytes, 64 * 1024 * 1024);
    return Promise.resolve({
      id: "read",
      kill: () => {
        kills++;
        resolveWait({} as never);
        return Promise.resolve();
      },
      wait: () => {
        waitStarted();
        return new Promise((resolve) => resolveWait = resolve);
      },
    });
  }));
  const controller = new AbortController();
  const result = tools.readFile("/tmp/a file", controller.signal);
  await waiting;
  controller.abort();

  await assertRejects(() => result, Error, "cancelled");
  assertEquals(kills, 1);
});

Deno.test("read_file returns text from a quoted sandbox path", async () => {
  const tools = createAgentTools(sandbox((cmd, opts) => {
    assertEquals(cmd, "cat -- '/tmp/a file'");
    assertEquals(opts?.timeoutMs, 120_000);
    return Promise.resolve({
      id: "read",
      kill: () => Promise.resolve(),
      wait: () =>
        Promise.resolve({
          code: 0,
          signal: null,
          timedOut: false,
          stdout: "first\nsecond\n",
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
        }),
    });
  }));

  assertEquals(
    await tools.readFile("/tmp/a file", new AbortController().signal),
    "first\nsecond\n",
  );
});

Deno.test("Stop settles while waiting for the sandbox to boot", async () => {
  const controller = new AbortController();
  let starts = 0;
  const waiting = waitForSandbox(
    {
      status: "idle",
      ready: new Promise(() => {}),
    } as Yurt,
    () => starts++,
    controller.signal,
  );

  assertEquals(starts, 1);
  controller.abort();
  await assertRejects(() => waiting, Error, "cancelled");
});
