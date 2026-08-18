import { assertEquals } from "@std/assert";
import {
  CREATE_GUEST_WORKER,
  dispatchGuestWorkerProxyEvent,
  GUEST_WORKER_ERROR,
} from "../src/page_worker_bridge.ts";

Deno.test("guest-worker factory messages use a reserved type", () => {
  assertEquals(CREATE_GUEST_WORKER, "yurt-create-guest-worker");
});

Deno.test("guest-worker failures become proxy error events", () => {
  const proxy = new EventTarget();
  let messageEvents = 0;
  let errorMessage = "";
  proxy.addEventListener("message", () => messageEvents++);
  proxy.addEventListener("error", (event) => {
    errorMessage = (event as ErrorEvent).message;
  });

  dispatchGuestWorkerProxyEvent(
    proxy,
    new MessageEvent("message", {
      data: { type: GUEST_WORKER_ERROR, message: "guest failed to load" },
    }),
  );

  assertEquals(messageEvents, 0);
  assertEquals(errorMessage, "guest failed to load");
});
