import {
  buildKernelStopCommand,
  JUPYTER_CONNECTION_FILE,
  JUPYTER_PID_FILE,
} from "../src/jupyter.ts";
import { assertEquals, assertRejects } from "@std/assert";
import {
  connectJupyterWithRetries,
  executeCell,
  hushUntil,
  interruptKernel,
  startGuestKernel,
} from "../src/jupyter.ts";
import type { JupyterMessage } from "../src/jupyter_protocol.ts";
import type {
  JupyterChannel,
  JupyterTransport,
} from "../src/jupyter_transport.ts";

Deno.test("executeCell collects standard Jupyter stream, result, and reply messages", async () => {
  let listener:
    | ((message: JupyterMessage, channel: JupyterChannel) => void)
    | undefined;
  const transport: JupyterTransport = {
    send(message) {
      const parent = { msg_id: message.header.msg_id };
      listener?.({
        header: {
          msg_id: "reply-1",
          username: "user",
          session: message.header.session,
          msg_type: "execute_reply",
          version: "5.3",
        },
        parent_header: parent,
        metadata: {},
        content: { status: "ok" },
      }, "shell");
      listener?.({
        header: {
          msg_id: "stream-1",
          username: "user",
          session: message.header.session,
          msg_type: "stream",
          version: "5.3",
        },
        parent_header: parent,
        metadata: {},
        content: { name: "stdout", text: "hello\n" },
      }, "iopub");
      listener?.({
        header: {
          msg_id: "result-1",
          username: "user",
          session: message.header.session,
          msg_type: "execute_result",
          version: "5.3",
        },
        parent_header: parent,
        metadata: {},
        content: { data: { "text/plain": "2" } },
      }, "iopub");
      listener?.({
        header: {
          msg_id: "status-1",
          username: "user",
          session: message.header.session,
          msg_type: "status",
          version: "5.3",
        },
        parent_header: parent,
        metadata: {},
        content: { execution_state: "idle" },
      }, "iopub");
      return Promise.resolve();
    },
    subscribe(next) {
      listener = next;
      return () => listener = undefined;
    },
    close() {
      return Promise.resolve();
    },
  };
  assertEquals(await executeCell(transport, "1+1"), {
    status: "ok",
    stdout: "hello\n",
    stderr: "",
    display: "2",
    traceback: [],
  });
});

Deno.test("executeCell keeps stderr apart from stdout", async () => {
  // The one machine-readable execution surface mixed a warning into the
  // result text (yurt-playground#83); a driver needs to tell them apart.
  let listener:
    | ((message: JupyterMessage, channel: JupyterChannel) => void)
    | undefined;
  const transport: JupyterTransport = {
    send(message) {
      const parent = message.header;
      const iopub = (msg_type: string, content: Record<string, unknown>) =>
        listener?.({
          header: {
            msg_id: `${msg_type}-1`,
            username: "user",
            session: message.header.session,
            msg_type,
            version: "5.3",
          },
          parent_header: parent,
          metadata: {},
          content,
        }, "iopub");
      iopub("stream", { name: "stdout", text: "out\n" });
      iopub("stream", { name: "stderr", text: "warn\n" });
      iopub("status", { execution_state: "idle" });
      listener?.({
        header: {
          msg_id: "reply-1",
          username: "user",
          session: message.header.session,
          msg_type: "execute_reply",
          version: "5.3",
        },
        parent_header: parent,
        metadata: {},
        content: { status: "ok" },
      }, "shell");
      return Promise.resolve();
    },
    subscribe(next) {
      listener = next;
      return () => listener = undefined;
    },
    close() {
      return Promise.resolve();
    },
  };
  assertEquals(await executeCell(transport, "print('out')"), {
    status: "ok",
    stdout: "out\n",
    stderr: "warn\n",
    display: "",
    traceback: [],
  });
});

Deno.test("a session that can spawn gets the kernel as its own process, not typed", async () => {
  const typed: string[] = [];
  const spawned: string[] = [];
  const handlers = new Set<(bytes: Uint8Array) => void>();
  const session = {
    terminal: {
      write(bytes: Uint8Array) {
        const line = new TextDecoder().decode(bytes);
        typed.push(line);
        // The connection-file read is still typed: answer it with "no
        // file", which ends the launch right there, spawn already done.
        const stop = line.match(/echo (YURT_SHELL_DONE_)""(\w+)/);
        if (stop !== null) {
          const reply = new TextEncoder().encode(`${stop[1]}${stop[2]}\n$ `);
          for (const handler of handlers) handler(reply);
        }
        // The stop line names the connection file too (it removes it), so
        // the branch below must not fire on it and answer "ready" during a
        // stop (#123 review).
        if (stop === null && typed.at(-1)?.includes(JUPYTER_CONNECTION_FILE)) {
          const reply = new TextEncoder().encode(
            "KERNEL_LOG\n(nothing)\nYURT_JUPYTER_CONNECTION_READY\n$ ",
          );
          for (const handler of handlers) handler(reply);
        }
        return Promise.resolve();
      },
    },
    spawn(line: string) {
      spawned.push(line);
      return Promise.resolve();
    },
    dialSandboxPort: () => {
      throw new Error("not dialed in this test");
    },
    onOutput(handler: (bytes: Uint8Array) => void) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
  };
  await assertRejects(
    () => startGuestKernel(session),
    Error,
    "connection file was not written",
  );
  assertEquals(spawned.length, 1);
  assertEquals(spawned[0].includes("exec python3 -m ipykernel_launcher"), true);
  assertEquals(typed.some((t) => t.includes("ipykernel_launcher")), false);
});

Deno.test("a launch whose connection file never comes stops the kernel it started", async () => {
  // yurt-playground#82, review: the kernel is a process of its own now,
  // so a failed launch would otherwise leave it running for nobody.
  const typed: string[] = [];
  const handlers = new Set<(bytes: Uint8Array) => void>();
  const session = {
    terminal: {
      write(bytes: Uint8Array) {
        const line = new TextDecoder().decode(bytes);
        typed.push(line);
        // The typed stop line ends with an echo marker; answer it.
        const marker = line.match(/echo (YURT_SHELL_DONE_)""(\w+)/);
        if (marker !== null) {
          const reply = new TextEncoder().encode(
            `${marker[1]}${marker[2]}\n$ `,
          );
          for (const handler of handlers) handler(reply);
        }
        return Promise.resolve();
      },
    },
    spawn: () => Promise.resolve(),
    readFile: () => Promise.reject(new Error("the launcher is gone")),
    dialSandboxPort: () => {
      throw new Error("not dialed in this test");
    },
    onOutput(handler: (bytes: Uint8Array) => void) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
  };
  await assertRejects(
    () => startGuestKernel(session, undefined, { pollMs: 1 }),
    Error,
    "the launcher is gone",
  );
  assertEquals(
    typed.some((t) => t.includes("kill -KILL")),
    true,
    `the stop line was typed: ${JSON.stringify(typed)}`,
  );
});

/// yurtos-kernel#2824: the "first command after boot takes ~20 s" was the
/// page's own connection-file wait loop, typed into the user's shell and
/// hushed -- `while [ ! -s file ]; do sleep 1; done` for as long as
/// ipykernel takes to import. Anything the user typed meanwhile queued
/// behind it. A session that can read guest files polls the file itself and
/// never types into the shell.
Deno.test("a session that can read guest files polls the connection file instead of typing the wait into the shell", async () => {
  const typed: string[] = [];
  const spawned: string[] = [];
  let reads = 0;
  const connection = JSON.stringify({
    shell_port: 1,
    iopub_port: 2,
    stdin_port: 3,
    control_port: 4,
    hb_port: 5,
    key: "k",
    transport: "tcp",
  });
  const session = {
    terminal: {
      write(bytes: Uint8Array) {
        typed.push(new TextDecoder().decode(bytes));
        return Promise.resolve();
      },
    },
    spawn(line: string) {
      spawned.push(line);
      return Promise.resolve();
    },
    readFile(path: string) {
      reads += 1;
      // The file appears on the third look, as ipykernel writes it late.
      if (path === JUPYTER_CONNECTION_FILE && reads >= 3) {
        return Promise.resolve(new TextEncoder().encode(connection));
      }
      return Promise.resolve(undefined);
    },
    dialSandboxPort: () => {
      throw new Error("the transport is not dialed in this test");
    },
    onOutput() {
      return () => {};
    },
  };
  // The launch is spawned and the file polled; the dial is where this
  // test stops: the connect retries give up on it.
  await assertRejects(
    () =>
      startGuestKernel(session, undefined, {
        pollMs: 1,
        connect: { attempts: 2, delayMs: 1 },
      }),
    Error,
    "did not become ready",
  );
  assertEquals(spawned.length, 1);
  assertEquals(reads >= 3, true, "the file was polled until it appeared");
  assertEquals(
    typed,
    [],
    "nothing is typed into the user's shell: no launch, no wait loop, no cat",
  );
});

Deno.test("executeCell removes its listener after a timeout", async () => {
  let subscriptions = 0;
  const transport: JupyterTransport = {
    send: () => Promise.resolve(),
    subscribe() {
      subscriptions++;
      return () => subscriptions--;
    },
    close: () => Promise.resolve(),
  };

  await assertRejects(() => executeCell(transport, "1+1", 0));
  assertEquals(subscriptions, 0);
});

Deno.test("kernel readiness retries close each failed transport", async () => {
  let closed = 0;
  await assertRejects(
    () =>
      connectJupyterWithRetries(
        () =>
          Promise.resolve({
            send: () => Promise.resolve(),
            subscribe: () => () => {},
            close: () => {
              closed++;
              return Promise.resolve();
            },
          }),
        () => Promise.reject(new Error("not ready")),
        { attempts: 2, delayMs: 0 },
      ),
  );
  assertEquals(closed, 2);
});

Deno.test("the stop command kills the recorded kernel and clears both files", () => {
  const command = buildKernelStopCommand();
  // SIGKILL by recorded pid: a kernel being restarted may be wedged, and
  // nothing else in the guest may be killed.
  assertEquals(command.includes(`kill -KILL $(cat ${JUPYTER_PID_FILE})`), true);
  assertEquals(command.includes(`wait $(cat ${JUPYTER_PID_FILE})`), true);
  // Both files go, so the relaunch cannot read a stale connection file.
  assertEquals(
    command.includes(`rm -f ${JUPYTER_CONNECTION_FILE} ${JUPYTER_PID_FILE}`),
    true,
  );
  // No pid file means nothing to kill, not a shell error.
  assertEquals(command.startsWith(`if [ -s ${JUPYTER_PID_FILE} ]`), true);
});

Deno.test("the launch is kept off the screen; the prompt after the marker is shown", () => {
  const handlers = new Set<(bytes: Uint8Array) => void>();
  const shown: string[] = [];
  const session = {
    terminal: { write: () => Promise.resolve() },
    dialSandboxPort: () => {
      throw new Error("not dialed");
    },
    onOutput(handler: (bytes: Uint8Array) => void) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    hushOutput: () => ({
      show(tail: Uint8Array) {
        shown.push(new TextDecoder().decode(tail));
      },
    }),
  };
  const emit = (text: string) => {
    for (const handler of handlers) handler(new TextEncoder().encode(text));
  };
  const release = hushUntil(session, "MARK");
  emit("python3 -m ipykernel_launcher ...\r\n{ json }\r\n");
  assertEquals(shown, []);
  // The marker and the shell's next prompt in one chunk: the prompt
  // survives, on a cleared line; the marker line does not.
  emit("MA");
  emit("RK\r\n$ ");
  assertEquals(shown, ["\r\x1b[2K$ "]);
  release();
  assertEquals(shown.length, 1);
  assertEquals(handlers.size, 0);

  // Released without the marker (the launch failed): the screen resumes
  // with nothing pending.
  const failed = hushUntil(session, "MARK");
  emit("no marker here\r\n");
  failed();
  assertEquals(shown, ["\r\x1b[2K$ ", "\r\x1b[2K"]);

  // A session that cannot hush (a plain transport) shows everything.
  const { hushOutput: _, ...plain } = session;
  hushUntil(plain, "MARK")();
  assertEquals(shown.length, 2);
});

Deno.test("executeCell hands over output as it arrives, not only at the end", async () => {
  // yurt-playground#131: the pane stayed empty for the whole of a cell --
  // 46 s for 30,000 prints -- and then showed everything at once, so a slow
  // cell and a hung one looked the same.
  let listener:
    | ((message: JupyterMessage, channel: JupyterChannel) => void)
    | undefined;
  const frame = (
    parent: string,
    msg_type: string,
    content: Record<string, unknown>,
  ) => ({
    header: {
      msg_id: crypto.randomUUID(),
      username: "user",
      session: "s",
      msg_type,
      version: "5.3",
    },
    parent_header: { msg_id: parent },
    metadata: {},
    content,
  });
  const transport: JupyterTransport = {
    send(message) {
      const id = message.header.msg_id;
      listener?.(
        frame(id, "stream", { name: "stdout", text: "one\n" }),
        "iopub",
      );
      listener?.(
        frame(id, "stream", { name: "stderr", text: "warn\n" }),
        "iopub",
      );
      listener?.(
        frame(id, "execute_result", { data: { "text/plain": "3" } }),
        "iopub",
      );
      listener?.(frame(id, "execute_reply", { status: "ok" }), "shell");
      listener?.(frame(id, "status", { execution_state: "idle" }), "iopub");
      return Promise.resolve();
    },
    subscribe(next) {
      listener = next;
      return () => listener = undefined;
    },
    close() {
      return Promise.resolve();
    },
  };
  const seen: string[] = [];
  const reply = await executeCell(
    transport,
    "print('one')",
    1000,
    (partial) =>
      seen.push(`${partial.stdout}|${partial.stderr}|${partial.display}`),
  );
  assertEquals(seen, [
    "one\n||",
    "one\n|warn\n|",
    "one\n|warn\n|3",
  ]);
  // and the reply still carries the whole of it
  assertEquals(reply.stdout, "one\n");
  assertEquals(reply.stderr, "warn\n");
  assertEquals(reply.display, "3");
});

Deno.test("interruptKernel asks on the control channel, where ipykernel can hear it mid-cell", async () => {
  // yurt-playground#130: the page had no way to stop a running cell, so a
  // loop cost the reader the whole boot.
  const sent: Array<{ type: string; channel: string | undefined }> = [];
  const transport: JupyterTransport = {
    send(message, channel) {
      sent.push({ type: message.header.msg_type, channel });
      return Promise.resolve();
    },
    subscribe() {
      return () => {};
    },
    close() {
      return Promise.resolve();
    },
  };
  await interruptKernel(transport);
  assertEquals(sent, [{ type: "interrupt_request", channel: "control" }]);
});
