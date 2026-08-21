import { assertEquals, assertRejects } from "@std/assert";
import {
  decodeJupyterMessage,
  encodeJupyterMessage,
  type JupyterMessage,
} from "../src/jupyter_protocol.ts";

const message: JupyterMessage = {
  header: {
    msg_id: "msg-1",
    username: "user",
    session: "session-1",
    msg_type: "execute_request",
    version: "5.3",
  },
  parent_header: {},
  metadata: { transient: { display_id: "display-1" } },
  content: { code: "1+1", silent: false },
  buffers: [new Uint8Array([0, 255, 2])],
};

Deno.test("Jupyter codec emits and reads signed multipart messages", async () => {
  const encoded = await encodeJupyterMessage(message, "secret");
  const decoded = await decodeJupyterMessage(encoded, "secret");
  assertEquals(decoded, message);
});

Deno.test("Jupyter codec rejects a message with the wrong HMAC key", async () => {
  const encoded = await encodeJupyterMessage(message, "secret");
  await assertRejects(
    () => decodeJupyterMessage(encoded, "wrong"),
    Error,
    "signature",
  );
});

Deno.test("Jupyter codec rejects truncated multipart messages", async () => {
  const encoded = await encodeJupyterMessage(message, "secret");
  await assertRejects(
    () => decodeJupyterMessage(encoded.slice(0, 5), "secret"),
    Error,
    "frame",
  );
});

Deno.test("Jupyter codec rejects a missing delimiter", async () => {
  await assertRejects(
    () =>
      decodeJupyterMessage(
        Array.from({ length: 6 }, () => new Uint8Array([1, 2, 3])),
        "secret",
      ),
    Error,
    "delimiter",
  );
});
