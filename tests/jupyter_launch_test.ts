import { assertEquals, assertNotEquals, assertRejects } from "@std/assert";
import {
  buildKernelLaunchCommand,
  buildKernelOwnProcessLine,
  buildKernelStartLine,
  generateJupyterKey,
  JUPYTER_CONNECTION_FILE,
  JUPYTER_LOG_FILE,
  JUPYTER_PID_FILE,
  startGuestKernel,
} from "../src/jupyter.ts";
import { encodeJupyterMessage } from "../src/jupyter_protocol.ts";
import { decodeJupyterChannelMessage } from "../src/jupyter_transport.ts";
import { stripAnsi } from "../src/notebook.ts";

const KEY = "test-key";

Deno.test("Jupyter launch uses Python 3 and a guest connection file", () => {
  assertEquals(
    buildKernelLaunchCommand(KEY),
    `python3 -m ipykernel_launcher --ip=127.0.0.1 --transport=tcp ` +
      `--Session.key=${KEY} --f=${JUPYTER_CONNECTION_FILE}`,
  );
});

Deno.test("the kernel start line backgrounds the launch and records its pid", () => {
  // Not in a subshell yet: on the native runtime a child is lost when its
  // parent exits (yurtos-kernel#2816), so the kernel stays a job of the
  // interactive shell for now (yurt-playground#82).
  const line = buildKernelStartLine(KEY);
  assertEquals(
    line,
    `rm -f ${JUPYTER_CONNECTION_FILE}; ${
      buildKernelLaunchCommand(KEY)
    } >${JUPYTER_LOG_FILE} 2>&1 & echo $! > ${JUPYTER_PID_FILE}`,
  );
});

Deno.test("stripAnsi removes ipykernel's colour codes from a traceback line", () => {
  assertEquals(
    stripAnsi("\x1b[31m---\x1b[39m ZeroDivisionError\x1b[0m: division by zero"),
    "--- ZeroDivisionError: division by zero",
  );
  assertEquals(stripAnsi("plain"), "plain");
});

Deno.test("as its own process the kernel records its pid and execs in place", () => {
  // Typed at the prompt, ipykernel was job [1] of the user's own shell and
  // `kill %1` killed it (yurt-playground#82). Spawned as the page's own
  // `sh -c`, the shell notes its pid (the kernel's, after exec) for the
  // stop command and becomes the kernel; no job table is involved.
  assertEquals(
    buildKernelOwnProcessLine(KEY),
    `echo $$ > ${JUPYTER_PID_FILE}; rm -f ${JUPYTER_CONNECTION_FILE}; exec ${
      buildKernelLaunchCommand(KEY)
    } >${JUPYTER_LOG_FILE} 2>&1`,
  );
});

Deno.test("generateJupyterKey is 32 random bytes of hex, never the old constant", () => {
  const a = generateJupyterKey();
  const b = generateJupyterKey();
  assertEquals(/^[0-9a-f]{64}$/.test(a), true);
  assertNotEquals(a, b);
  assertNotEquals(a, "yurt");
});

function keyOf(line: string): string {
  const m = line.match(/--Session\.key=(\S+)/);
  if (m === null) throw new Error(`no --Session.key in: ${line}`);
  return m[1];
}

function connectionFor(key: string): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    shell_port: 1,
    iopub_port: 2,
    stdin_port: 3,
    control_port: 4,
    hb_port: 5,
    key,
    transport: "tcp",
  }));
}

/** Launch a kernel against a session that serves a connection file echoing
 * the key it was launched with, as ipykernel does. Returns the launched
 * line and the key the transport would be configured with. */
async function launchOnce(): Promise<{ line: string; used: string }> {
  let line = "";
  const session = {
    terminal: { write: () => Promise.resolve() },
    spawn(l: string) {
      line = l;
      return Promise.resolve();
    },
    readFile: (path: string) =>
      Promise.resolve(
        path === JUPYTER_CONNECTION_FILE
          ? connectionFor(keyOf(line))
          : undefined,
      ),
    dialSandboxPort: () => {
      throw new Error("not dialed");
    },
    onOutput: () => () => {},
  };
  // The dial is where this stops; the launch line is what is under test.
  await assertRejects(
    () =>
      startGuestKernel(session, undefined, {
        pollMs: 1,
        connect: { attempts: 1, delayMs: 1 },
      }),
    Error,
    "did not become ready",
  );
  return { line, used: keyOf(line) };
}

Deno.test("two launches get different keys, neither the old fixed one", async () => {
  const first = await launchOnce();
  const second = await launchOnce();
  assertNotEquals(first.used, second.used);
  for (const { used } of [first, second]) {
    assertNotEquals(used, "yurt");
    assertEquals(/^[0-9a-f]{64}$/.test(used), true);
  }
});

const message = {
  header: {
    msg_id: "m1",
    username: "u",
    session: "s",
    msg_type: "stream",
    version: "5.3",
  },
  parent_header: {},
  metadata: {},
  content: { name: "stdout", text: "hi" },
};

Deno.test("a message signed with the old fixed key is rejected; the launch key works", async () => {
  const { used } = await launchOnce();
  const topic = new TextEncoder().encode("stream.stdout");
  const forged = await encodeJupyterMessage(message, "yurt");
  await assertRejects(
    () => decodeJupyterChannelMessage([topic, ...forged], used),
    Error,
    "signature mismatch",
  );
  const genuine = await encodeJupyterMessage(message, used);
  assertEquals(
    await decodeJupyterChannelMessage([topic, ...genuine], used),
    { ...message, buffers: [] },
  );
});
