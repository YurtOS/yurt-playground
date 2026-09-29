import { assertEquals } from "@std/assert";
import {
  parseGuestReply,
  parseGuestRequest,
  parseLifecycleMessage,
} from "../src/datasette_protocol.ts";
const session = "11111111-1111-4111-8111-111111111111";
const request = {
  type: "datasette-http",
  session,
  requestId: "r1",
  method: "GET",
  path: `/apps/datasette/${session}/orders`,
  headers: [["Accept", "application/json"]],
};
Deno.test("Datasette protocol accepts scoped GET/HEAD requests", () => {
  assertEquals(parseGuestRequest(request), request);
  assertEquals(
    parseGuestRequest({ ...request, type: "guest-http-request" }),
    undefined,
  );
  assertEquals(
    parseGuestRequest({ ...request, method: "HEAD" })?.method,
    "HEAD",
  );
});
Deno.test("Datasette protocol rejects malformed or foreign request fields", () => {
  for (
    const change of [
      { method: "POST" },
      { session: "other" },
      { requestId: "" },
      { path: "/outside" },
      { headers: [["Accept", "x\r\nInjected:1"]] },
      { headers: [["Accept"]] },
      { path: `/apps/datasette/${session}/%2e%2e/out` },
    ]
  ) assertEquals(parseGuestRequest({ ...request, ...change }), undefined);
});
Deno.test("Datasette protocol validates response body and status before relay", () => {
  const reply = {
    type: "datasette-response",
    session,
    requestId: "r1",
    status: 200,
    headers: [["Content-Type", "text/plain"]],
    body: new ArrayBuffer(3),
  };
  assertEquals<unknown>(parseGuestReply(reply), reply);
  for (
    const change of [{ status: 101 }, { status: 600 }, { body: [1, 2, 3] }, {
      session: "bad",
    }, { headers: [["bad name", "yes"]] }]
  ) assertEquals(parseGuestReply({ ...reply, ...change }), undefined);
});
Deno.test("Datasette lifecycle parser rejects unrelated or uncorrelated messages", () => {
  assertEquals(
    parseLifecycleMessage({ type: "datasette-stop", requestId: "r1" }),
    { type: "datasette-stop", requestId: "r1" },
  );
  assertEquals(
    parseLifecycleMessage({ type: "datasette-start", requestId: "" }),
    undefined,
  );
  assertEquals(
    parseLifecycleMessage({ type: "yurt-spawn", requestId: "r1" }),
    undefined,
  );
});
