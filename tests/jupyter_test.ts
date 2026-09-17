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
        typed.push(new TextDecoder().decode(bytes));
        // The connection-file read is still typed: answer it with "no
        // file", which ends the launch right there, spawn already done.
        if (typed.at(-1)?.includes(JUPYTER_CONNECTION_FILE)) {
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
