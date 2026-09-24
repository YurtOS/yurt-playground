import { assertEquals } from "@std/assert";
import { requestCellInterrupt } from "../src/cell_interrupt.ts";
import type { JupyterTransport } from "../src/jupyter_transport.ts";

Deno.test("a failed interrupt replies on the matching cell error path", async () => {
  const replies: unknown[] = [];
  const transport: JupyterTransport = {
    send: () => Promise.reject(new Error("control channel closed")),
    subscribe: () => () => {},
    close: () => Promise.resolve(),
  };

  await requestCellInterrupt(
    transport,
    "cell-7",
    (reply) => replies.push(reply),
  );

  assertEquals(replies, [{
    type: "cell-error",
    id: "cell-7",
    message: "control channel closed",
  }]);
});

Deno.test("an interrupt without a ready kernel settles the matching cell", async () => {
  const replies: unknown[] = [];
  await requestCellInterrupt(
    undefined,
    "cell-8",
    (reply) => replies.push(reply),
  );

  assertEquals(replies, [{
    type: "cell-error",
    id: "cell-8",
    message: "Jupyter is not ready",
  }]);
});
