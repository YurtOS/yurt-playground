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
import {
  decodeJupyterMessage,
  encodeJupyterMessage,
} from "../src/jupyter_protocol.ts";
import {
  decodeJupyterChannelMessage,
  decodeZmtpFrames,
  encodeZmtpGreeting,
  encodeZmtpMessage,
  encodeZmtpReady,
} from "../src/jupyter_transport.ts";
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

/** A session with no `spawn` and no `readFile` (a launcher older than the
 * API): the launch and the connection-file read are both typed at the prompt.
 * The "shell" answers the `cat` of the connection file with `fileFor(key)`,
 * where `key` is the one the launch line set. */
function typedSession(fileFor: (launchKey: string) => unknown) {
  const listeners = new Set<(chunk: Uint8Array) => void>();
  const typedLines: string[] = [];
  let launchKey = "";
  const emit = (text: string) => {
    for (const listener of listeners) listener(new TextEncoder().encode(text));
  };
  return {
    typedLines,
    terminal: {
      write(bytes: Uint8Array) {
        const typed = new TextDecoder().decode(bytes);
        typedLines.push(typed);
        const m = typed.match(/--Session\.key=(\S+)/);
        if (m !== null) launchKey = m[1];
        if (typed.includes(`cat ${JUPYTER_CONNECTION_FILE}`)) {
          emit(
            `${
              JSON.stringify(fileFor(launchKey))
            }\nYURT_JUPYTER_CONNECTION_READY\n`,
          );
        }
        // runShell types `...; echo YURT_SHELL_DONE_""xxxxxx` and waits for
        // the shell to print the marker with the quotes gone.
        const done = typed.match(/echo (YURT_SHELL_DONE_)""(\w+)/);
        if (done !== null) emit(`${done[1]}${done[2]}\n`);
        return Promise.resolve();
      },
    },
    dialSandboxPort: () => {
      throw new Error("not dialed");
    },
    onOutput(listener: (chunk: Uint8Array) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

const connectionWith = (key: string) => ({
  shell_port: 1,
  iopub_port: 2,
  stdin_port: 3,
  control_port: 4,
  hb_port: 5,
  key,
  transport: "tcp",
});

Deno.test("typed at the prompt, a stale connection file with another key is refused and the kernel stopped", async () => {
  // The old fixed key a previous launch used, left behind in /tmp.
  const session = typedSession(() => connectionWith("yurt"));
  await assertRejects(
    () =>
      startGuestKernel(session, undefined, {
        connect: { attempts: 1, delayMs: 1 },
      }),
    Error,
    "a stale kernel connection file was read",
  );
  // The launch is not left running for nobody: a stop was typed after it.
  const stop = session.typedLines.findIndex((line) =>
    line.includes(JUPYTER_PID_FILE) && line.includes("kill")
  );
  const launch = session.typedLines.findIndex((line) =>
    line.includes("--Session.key=")
  );
  assertEquals(
    stop > launch && launch >= 0,
    true,
    session.typedLines.join("|"),
  );
});

Deno.test("typed at the prompt, the file carrying this launch's key is accepted", async () => {
  // Same path, same session: only the key differs, so the refusal above is
  // the key check and not something else on the typed path.
  await assertRejects(
    () =>
      startGuestKernel(typedSession(connectionWith), undefined, {
        connect: { attempts: 1, delayMs: 1 },
      }),
    Error,
    "did not become ready",
  );
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

/** One port of a running ipykernel, as far as the page's dial sees it: the
 * ZMTP handshake, and on the control port a kernel_info_reply to each
 * kernel_info_request signed with `key` (unless `silent`). The shell port
 * never answers: the kernel is busy with a cell, which must not keep a
 * page from attaching. */
class KernelPort {
  #incoming: Uint8Array[] = [
    encodeZmtpGreeting(true),
    encodeZmtpReady(),
  ];
  #waiting: ((chunk: Uint8Array) => void) | undefined;
  #writes = 0;
  constructor(
    readonly control: boolean,
    readonly key: string,
    readonly silent: boolean,
  ) {}
  #push(bytes: Uint8Array): void {
    if (this.#waiting !== undefined) {
      const waiting = this.#waiting;
      this.#waiting = undefined;
      waiting(bytes);
    } else this.#incoming.push(bytes);
  }
  async write(bytes: Uint8Array): Promise<void> {
    // The first two writes are the page's greeting and READY.
    if (++this.#writes <= 2 || !this.control || this.silent) return;
    const request = await decodeJupyterMessage(
      decodeZmtpFrames(bytes),
      this.key,
    );
    if (request.header.msg_type !== "kernel_info_request") return;
    const reply = await encodeJupyterMessage({
      header: { ...request.header, msg_type: "kernel_info_reply" },
      parent_header: request.header,
      metadata: {},
      content: { status: "ok" },
    }, this.key);
    this.#push(encodeZmtpMessage(reply));
  }
  async read(length: number): Promise<Uint8Array> {
    const next = this.#incoming.shift() ??
      await new Promise<Uint8Array>((resolve) => this.#waiting = resolve);
    // At most `length` bytes, as a socket read gives; the rest waits.
    if (next.length > length) this.#incoming.unshift(next.slice(length));
    return next.slice(0, length);
  }
  close(): Promise<void> {
    this.#waiting?.(new Uint8Array());
    return Promise.resolve();
  }
}

/** A port nothing listens on, as the desktop's dial sees one: a socket
 * that opens and is closed at once. */
const closedPort = {
  write: () => Promise.resolve(),
  read: () => Promise.resolve(new Uint8Array()),
  close: () => Promise.resolve(),
};

/** A sandbox where another page left a kernel's connection file (the
 * desktop app's main page, when its Notebook page opens). `kernel`:
 * "answers" and "silent" listen on its ports; "gone" means nothing does.
 * Records every line spawned and every port dialed. */
function sharedSandbox(kernel: "answers" | "silent" | "gone") {
  const key = "the-first-page-s-key";
  const spawned: string[] = [];
  const dialed: number[] = [];
  const files = new Map<string, Uint8Array>([
    [JUPYTER_PID_FILE, new TextEncoder().encode("105\n")],
    [JUPYTER_CONNECTION_FILE, connectionFor(key)],
  ]);
  const session = {
    terminal: { write: () => Promise.resolve() },
    spawn(line: string) {
      spawned.push(line);
      return Promise.resolve({ exited: Promise.resolve(0) });
    },
    readFile: (path: string) => Promise.resolve(files.get(path)),
    dialSandboxPort: (port: number) => {
      dialed.push(port);
      return kernel === "gone"
        ? closedPort
        : new KernelPort(port === 4, key, kernel === "silent");
    },
    onOutput: () => () => {},
  };
  return { session, spawned, dialed };
}

Deno.test("a running kernel, busy or not, is attached to, not launched over or killed", async () => {
  const { session, spawned } = sharedSandbox("answers");
  const transport = await startGuestKernel(session, undefined, { pollMs: 1 });
  await transport.close();
  assertEquals(spawned, [], "nothing launched, stopped or removed");
});

Deno.test("a running kernel that does not answer fails the start and is left alone", async () => {
  const { session, spawned } = sharedSandbox("silent");
  await assertRejects(
    () => startGuestKernel(session, undefined, { pollMs: 1 }),
    Error,
    "the Jupyter kernel already running in this sandbox",
  );
  assertEquals(spawned, [], "the other page's kernel is not stopped");
});

Deno.test("a connection file nothing listens behind gets a fresh launch, and no file is removed for it", async () => {
  const { session, spawned } = sharedSandbox("gone");
  await assertRejects(
    () =>
      startGuestKernel(session, undefined, {
        pollMs: 1,
        connect: { attempts: 1, delayMs: 1 },
      }),
    Error,
  );
  // The launch line replaces the files itself; the attach removes none.
  assertEquals(
    spawned[0]?.includes("ipykernel_launcher"),
    true,
    `the launch comes first: ${spawned}`,
  );
  assertEquals(spawned.some((line) => line.includes("kill")), false);
});

Deno.test("a connection file naming other ports than the host maps is not dialed", async () => {
  const { session, spawned, dialed } = sharedSandbox("answers");
  await assertRejects(
    () =>
      startGuestKernel(session, [11, 12, 13, 14, 15], {
        pollMs: 1,
        connect: { attempts: 1, delayMs: 1 },
      }),
    Error,
  );
  assertEquals(
    dialed.filter((port) => port < 11),
    [],
    "the file's ports 1-5 are never dialed",
  );
  assertEquals(spawned[0]?.includes("ipykernel_launcher"), true);
});

Deno.test("typed at the prompt (the desktop's Notebook page), a running kernel is attached to", async () => {
  // No `spawn`, no `readFile`: the page looks at the connection file with a
  // line typed into the shell, as the desktop's Notebook page does.
  const key = "the-first-page-s-key";
  const typed: string[] = [];
  const handlers = new Set<(bytes: Uint8Array) => void>();
  const session = {
    terminal: {
      write(bytes: Uint8Array) {
        const line = new TextDecoder().decode(bytes);
        typed.push(line);
        const marker = line.match(/echo (YURT_SHELL_DONE_)""(\w+)/);
        if (marker !== null) {
          const shown = line.includes(`cat ${JUPYTER_CONNECTION_FILE}`)
            ? new TextDecoder().decode(connectionFor(key))
            : "";
          const reply = new TextEncoder().encode(
            `${line}${shown}\n${marker[1]}${marker[2]}\n$ `,
          );
          for (const handler of handlers) handler(reply);
        } else if (line.includes('YURT_JUPYTER_CONNECTION_""READY')) {
          // A launch's wait for its own file: none comes, so a page that
          // launched (instead of attaching) fails here at once.
          const reply = new TextEncoder().encode(
            "KERNEL_LOG\n(nothing)\nYURT_JUPYTER_CONNECTION_READY\n$ ",
          );
          for (const handler of handlers) handler(reply);
        }
        return Promise.resolve();
      },
    },
    dialSandboxPort: (port: number) => new KernelPort(port === 4, key, false),
    onOutput(handler: (bytes: Uint8Array) => void) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
  };
  const transport = await startGuestKernel(session);
  await transport.close();
  assertEquals(typed.length, 1, `only the look was typed: ${typed}`);
  assertEquals(typed[0].includes("ipykernel_launcher"), false);
});

Deno.test("a dial whose handshake never comes is closed when its try runs out, then a fresh launch", async () => {
  // A port that a non-kernel listener holds, and that never greets: each
  // bounded try is abandoned whole, every socket it dialed closed, and no
  // transport is left behind; then the page launches.
  const conns: { closed: boolean }[] = [];
  const { session, spawned } = sharedSandbox("answers");
  session.dialSandboxPort = () => {
    let release: ((bytes: Uint8Array) => void) | undefined;
    const conn = {
      closed: false,
      write: () => Promise.resolve(),
      read: () => new Promise<Uint8Array>((resolve) => release = resolve),
      close: () => {
        conn.closed = true;
        release?.(new Uint8Array());
        return Promise.resolve();
      },
    };
    conns.push(conn);
    return conn as unknown as KernelPort;
  };
  await assertRejects(
    () =>
      startGuestKernel(session, undefined, {
        pollMs: 1,
        connect: { attempts: 1, delayMs: 1 },
        attach: { dials: 2, dialMs: 20 },
      }),
    Error,
  );
  assertEquals(conns.length, 10, "two tries, five ports each");
  assertEquals(
    conns.filter((conn) => !conn.closed).length,
    0,
    "every socket a try dialed was closed",
  );
  assertEquals(spawned[0]?.includes("ipykernel_launcher"), true);
});
