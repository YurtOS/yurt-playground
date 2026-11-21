import { assert, assertEquals, assertRejects } from "@std/assert";
import { executeCell } from "../src/jupyter.ts";
import type { JupyterTransport } from "../src/jupyter_transport.ts";

Deno.test("an aborted executeCell settles at once with the abort's reason, its listener removed", async () => {
  let subscriptions = 0;
  const transport: JupyterTransport = {
    send: () => Promise.resolve(),
    subscribe() {
      subscriptions++;
      return () => subscriptions--;
    },
    close: () => Promise.resolve(),
  };
  const scope = new AbortController();
  const started = Date.now();
  const cell = executeCell(transport, "while True: pass", {
    signal: scope.signal,
  });
  scope.abort(new Error("the sandbox was replaced"));
  await assertRejects(() => cell, Error, "the sandbox was replaced");
  assertEquals(subscriptions, 0);
  assert(Date.now() - started < 1000, "not the 120 s timeout");
  // Already aborted: refused before anything is sent.
  let sent = 0;
  await assertRejects(
    () =>
      executeCell(
        { ...transport, send: () => (sent++, Promise.resolve()) },
        "1",
        {
          signal: scope.signal,
        },
      ),
    Error,
    "the sandbox was replaced",
  );
  assertEquals(sent, 0);
});

Deno.test("a cell that settles lets go of its sandbox's signal", async () => {
  let listening = 0;
  const signal = {
    aborted: false,
    throwIfAborted() {},
    addEventListener: () => listening++,
    removeEventListener: () => listening--,
  } as unknown as AbortSignal;
  const transport: JupyterTransport = {
    send: () => Promise.resolve(),
    subscribe: () => () => {},
    close: () => Promise.resolve(),
  };
  await assertRejects(() =>
    executeCell(transport, "1+1", { timeoutMs: 0, signal })
  );
  assertEquals(listening, 0);
});
