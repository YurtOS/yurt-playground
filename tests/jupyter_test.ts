import { assertEquals, assertRejects } from "@std/assert";
import {
  connectJupyterWithRetries,
  executeCell,
  shutdownGuestKernel,
  waitForGuestKernelExit,
} from "../src/jupyter.ts";
import type { JupyterMessage } from "../src/jupyter_protocol.ts";
import type { JupyterTransport } from "../src/jupyter_transport.ts";

Deno.test("executeCell collects standard Jupyter stream, result, and reply messages", async () => {
  let listener: ((message: JupyterMessage) => void) | undefined;
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
      });
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
      });
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
      });
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
      });
      return Promise.resolve();
    },
    sendControl: () => Promise.resolve(),
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
    display: "2",
    traceback: [],
  });
});

Deno.test("executeCell removes its listener after a timeout", async () => {
  let subscriptions = 0;
  const transport: JupyterTransport = {
    send: () => Promise.resolve(),
    sendControl: () => Promise.resolve(),
    subscribe() {
      subscriptions++;
      return () => subscriptions--;
    },
    close: () => Promise.resolve(),
  };

  await assertRejects(() => executeCell(transport, "1+1", 0));
  assertEquals(subscriptions, 0);
});

Deno.test("shutdownGuestKernel sends a control shutdown request", async () => {
  let sent: JupyterMessage | undefined;
  let listener: ((message: JupyterMessage) => void) | undefined;
  const transport: JupyterTransport = {
    send: () => {
      return Promise.resolve();
    },
    sendControl: (message) => {
      sent = message;
      queueMicrotask(() =>
        listener?.({
          header: {
            msg_id: "reply",
            username: "user",
            session: message.header.session,
            msg_type: "shutdown_reply",
            version: "5.3",
          },
          parent_header: { msg_id: message.header.msg_id },
          metadata: {},
          content: { restart: false },
        })
      );
      return Promise.resolve();
    },
    subscribe: (next) => {
      listener = next;
      return () => listener = undefined;
    },
    close: () => Promise.resolve(),
  };

  await shutdownGuestKernel(transport);
  assertEquals(sent?.header.msg_type, "shutdown_request");
  assertEquals(sent?.content, { restart: false });
});

Deno.test("waitForGuestKernelExit observes the guest exit marker", async () => {
  const handlers = new Set<(bytes: Uint8Array) => void>();
  let command = "";
  const session = {
    terminal: {
      write: (input: Uint8Array) => {
        command = new TextDecoder().decode(input);
        const output = new TextEncoder().encode("YURT_JUPYTER_EXITED\n");
        for (const handler of handlers) handler(output);
        return Promise.resolve();
      },
    },
    onOutput(handler: (bytes: Uint8Array) => void) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
  };

  await waitForGuestKernelExit(session);
  if (!command.includes("/proc/$pid/cmdline")) {
    throw new Error("exit probe does not validate the launched process");
  }
});

Deno.test("kernel readiness retries close each failed transport", async () => {
  let closed = 0;
  await assertRejects(
    () =>
      connectJupyterWithRetries(
        () =>
          Promise.resolve({
            send: () => Promise.resolve(),
            sendControl: () => Promise.resolve(),
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
