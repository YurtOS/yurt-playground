import { assert, assertEquals } from "@std/assert";
import {
  parseGuestReply,
  parseGuestRequest,
  parseLifecycleMessage,
  parseOwnerMessage,
} from "../src/datasette_protocol.ts";
const session = "11111111-1111-4111-8111-111111111111";
const request = {
  type: "datasette-http",
  app: "datasette",
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
      { method: "TRACE" },
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
Deno.test("request parsing: app, all methods, body and referrer", () => {
  const base = {
    type: "datasette-http",
    app: "preview",
    session,
    requestId: "r",
    path: `/apps/preview/${session}/x`,
    headers: [],
  };
  for (
    const method of ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]
  ) {
    assert(parseGuestRequest({ ...base, method }));
  }
  assert(parseGuestRequest({
    ...base,
    method: "POST",
    body: new ArrayBuffer(3),
    referrer: `/apps/preview/${session}/p`,
  }));
  assertEquals(parseGuestRequest({ ...base, method: "TRACE" }), undefined);
  assertEquals(
    parseGuestRequest({ ...base, app: "nope", method: "GET" }),
    undefined,
  );
  assertEquals(
    parseGuestRequest({ ...base, app: "datasette", method: "GET" }),
    undefined,
  );
  assertEquals(
    parseGuestRequest({ ...base, method: "POST", body: "text" }),
    undefined,
  );
  assertEquals(
    parseGuestRequest({ ...base, method: "POST", referrer: "/elsewhere" }),
    undefined,
  );
  assertEquals(
    parseGuestRequest({
      ...base,
      method: "POST",
      body: new ArrayBuffer(16 * 1024 * 1024 + 1),
    }),
    undefined,
  );
});

Deno.test("lifecycle and owner messages require a valid app; empty hash list registers", () => {
  assertEquals(
    parseLifecycleMessage({ type: "datasette-start", requestId: "r" }),
    undefined,
  );
  assert(
    parseLifecycleMessage({
      type: "datasette-start",
      app: "preview",
      requestId: "r",
    }),
  );
  assert(parseOwnerMessage({
    type: "datasette-register",
    app: "preview",
    session,
    nonce: "n",
    prefix: `/apps/preview/${session}/`,
    hashes: [],
  }));
  assertEquals(
    parseOwnerMessage({
      type: "datasette-register",
      app: "preview",
      session,
      nonce: "n",
      prefix: `/apps/datasette/${session}/`,
      hashes: [],
    }),
    undefined,
  );
  assertEquals(
    parseOwnerMessage({
      type: "datasette-register",
      session,
      nonce: "n",
      prefix: `/apps/datasette/${session}/`,
      hashes: [],
    }),
    undefined,
  );
});

Deno.test("HTTP 400 guest errors survive protocol parsing", () => {
  const reply = {
    type: "datasette-error" as const,
    session,
    requestId: "r1",
    code: 400,
    message: "Bad Request",
  };
  assertEquals(parseGuestReply(structuredClone(reply)), reply);
});
Deno.test("Datasette lifecycle parser rejects unrelated or uncorrelated messages", () => {
  assertEquals(
    parseLifecycleMessage({
      type: "datasette-stop",
      app: "datasette",
      requestId: "r1",
    }),
    { type: "datasette-stop", app: "datasette", requestId: "r1" },
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
