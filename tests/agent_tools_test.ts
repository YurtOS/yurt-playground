import { assertEquals, assertRejects } from "@std/assert";
import type { Yurt } from "../src/agent_api.ts";
import {
  DEMO_PDF_MADE,
  DEMO_TEXT_PATH,
  MAKE_DEMO_PDF,
  ToolFailed,
  type Tools,
} from "../src/agent.ts";
import { PYTHON_PROBE_COMMAND } from "../src/coordinator_start.ts";
import {
  createAgentTools,
  sandboxHasPython,
  waitForSandbox,
} from "../src/agent_tools.ts";

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
        coreDumped: false,
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
          coreDumped: false,
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
          coreDumped: false,
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

Deno.test("the agent probe says no python3 only on the missing code", async () => {
  const signal = new AbortController().signal;
  const tools = (code: number | null, fail = false): Tools => ({
    exec: (cmd) => {
      assertEquals(cmd, PYTHON_PROBE_COMMAND);
      return fail
        ? Promise.reject(new Error("no slot"))
        : Promise.resolve({ code, stdout: "", stderr: "" });
    },
    readFile: () => Promise.reject(new Error("unused")),
    writeFile: () => Promise.reject(new Error("unused")),
  });
  assertEquals(await sandboxHasPython(tools(0), signal), true);
  assertEquals(await sandboxHasPython(tools(42), signal), false);
  // Anything else cannot tell, and keeps the prompt the agent always had.
  assertEquals(await sandboxHasPython(tools(127), signal), true);
  assertEquals(await sandboxHasPython(tools(null), signal), true);
  assertEquals(await sandboxHasPython(tools(0, true), signal), true);
});

Deno.test("the agent's prompt keeps Python 3 on an image whose python3 lacks the kernel's packages", async () => {
  const signal = new AbortController().signal;
  // The probe run by the host's own /bin/sh against a guest root.
  const hostTools = (root: string): Tools => ({
    exec: async (cmd) => {
      const output = await new Deno.Command("/bin/sh", {
        args: ["-c", cmd.replaceAll("/usr/local/", `${root}/usr/local/`)],
        clearEnv: true,
        env: { PATH: `${root}/usr/local/bin` },
        stdout: "null",
        stderr: "null",
      }).output();
      return { code: output.code, stdout: "", stderr: "" };
    },
    readFile: () => Promise.reject(new Error("unused")),
    writeFile: () => Promise.reject(new Error("unused")),
  });
  const root = await Deno.makeTempDir({ prefix: "agent-pyprobe-" });
  try {
    await Deno.mkdir(`${root}/usr/local/bin`, { recursive: true });
    await Deno.mkdir(`${root}/usr/local/lib/python3.14/site-packages`, {
      recursive: true,
    });
    // Today's slim image: no python3.
    assertEquals(await sandboxHasPython(hostTools(root), signal), false);
    // The next slim image: python3 alone. It runs Python 3, which is all
    // the prompt says.
    await Deno.writeTextFile(`${root}/usr/local/bin/python3`, "#!/bin/sh\n");
    await Deno.chmod(`${root}/usr/local/bin/python3`, 0o755);
    assertEquals(await sandboxHasPython(hostTools(root), signal), true);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("a command that hit its limit says so, with the limit pkg's lock needs", async () => {
  let limit: number | undefined;
  const yurt = {
    spawn: (_cmd: string, opts: { timeoutMs: number }) => {
      limit = opts.timeoutMs;
      return Promise.resolve({
        id: "slow",
        kill: () => Promise.resolve(),
        wait: () =>
          Promise.resolve({
            timedOut: true,
            killAttempted: true,
            stillRunning: true,
            stdout: "",
            stderr: "partial\n",
            stdoutTruncated: false,
            stderrTruncated: false,
          }),
      });
    },
  } as unknown as Yurt;
  const result = await createAgentTools(yurt).exec(
    "sudo pkg install mkpdf",
    new AbortController().signal,
  );
  assertEquals(result.code, null);
  assertEquals(result.stderr, "partial\ntimed out after 120 s\n");
  assertEquals(limit, 120_000);
});

function writingSandbox(code: number | null) {
  const written: string[] = [];
  const commands: string[] = [];
  const yurt = {
    fs: {
      write: (path: string, data: string) => {
        written.push(`${path}:${data}`);
        return Promise.resolve();
      },
    },
    spawn: (cmd: string) => {
      commands.push(cmd);
      return Promise.resolve({
        id: "make",
        kill: () => Promise.resolve(),
        wait: () =>
          Promise.resolve({
            code,
            signal: null,
            coreDumped: false,
            timedOut: false,
            stdout: "",
            stderr: code === 0 ? "" : "a page holds 40\n",
            stdoutTruncated: false,
            stderrTruncated: false,
          }),
      });
    },
  } as unknown as Yurt;
  return { yurt, written, commands };
}

Deno.test("writeFile writes through the sandbox's files, absolute paths only", async () => {
  const { yurt, written, commands } = writingSandbox(0);
  const tools = createAgentTools(yurt);
  const never = new AbortController().signal;
  assertEquals(
    await tools.writeFile("/home/user/a", "text", never),
    "wrote 4 characters to /home/user/a",
  );
  assertEquals(written, ["/home/user/a:text"]);
  assertEquals(commands, []);
  await assertRejects(() => tools.writeFile("a", "text", never));
});

Deno.test("writing the demo's text makes its PDF, and says when it could not", async () => {
  const never = new AbortController().signal;
  const good = writingSandbox(0);
  assertEquals(
    await createAgentTools(good.yurt).writeFile(DEMO_TEXT_PATH, "ab", never),
    `wrote 2 characters to ${DEMO_TEXT_PATH}; ${DEMO_PDF_MADE}`,
  );
  assertEquals(good.commands, [MAKE_DEMO_PDF]);
  // The PDF itself is not the model's to write: text there would destroy it.
  const pdf = writingSandbox(0);
  await assertRejects(
    () =>
      createAgentTools(pdf.yurt).writeFile("/home/user/demo.pdf", "x", never),
    Error,
    "is made from",
  );
  assertEquals(pdf.written, []);
  const other = writingSandbox(0);
  await createAgentTools(other.yurt).writeFile(
    "/home/user/./demo.txt",
    "ab",
    never,
  );
  assertEquals(other.commands, [MAKE_DEMO_PDF]);
  const long = writingSandbox(3);
  const refused = await createAgentTools(long.yurt)
    .writeFile(DEMO_TEXT_PATH, "ab", never).catch((e) => e);
  assertEquals(refused.message.includes("a page holds 40"), true);
  assertEquals(
    refused instanceof ToolFailed,
    false,
    "the model can shorten it",
  );
  const broken = writingSandbox(127);
  const failed = await createAgentTools(broken.yurt)
    .writeFile(DEMO_TEXT_PATH, "ab", never).catch((e) => e);
  assertEquals(failed instanceof ToolFailed, true, "the model cannot fix it");
});
