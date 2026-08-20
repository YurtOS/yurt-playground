import { assertEquals, assertRejects } from "@std/assert";
import {
  createSessionController,
  type SessionTransportSet,
} from "../src/session_controller.ts";

type TestTransport = SessionTransportSet["pty"] & {
  name: string;
  writes: Uint8Array[];
  closed: boolean;
};

function transport(name: string): TestTransport {
  const result: TestTransport = {
    name,
    writes: [],
    closed: false,
    async write(bytes: Uint8Array) {
      result.writes.push(bytes);
    },
    close() {
      result.closed = true;
    },
  };
  return result;
}

Deno.test("session controller retains the old transport until commit", async () => {
  const oldPty = transport("old");
  const nextPty = transport("next");
  const controller = createSessionController({ pty: oldPty });

  await controller.quiesce();
  assertEquals(controller.state, "restoring");
  assertEquals(controller.current.pty, oldPty);

  await controller.commitTransportSwap({ pty: nextPty });
  assertEquals(controller.state, "ready");
  assertEquals(controller.current.pty, nextPty);
  assertEquals(oldPty.closed, true);
});

Deno.test("session controller rolls back to the old transport", async () => {
  const oldPty = transport("old");
  const controller = createSessionController({ pty: oldPty });

  await controller.quiesce();
  await controller.rollback();
  assertEquals(controller.state, "ready");
  assertEquals(controller.current.pty, oldPty);
  assertEquals(oldPty.closed, false);
});

Deno.test("session controller rejects a swap before quiescence", async () => {
  const controller = createSessionController({ pty: transport("old") });
  await assertRejects(
    () => controller.commitTransportSwap({ pty: transport("next") }),
    Error,
    "quiesce",
  );
});
