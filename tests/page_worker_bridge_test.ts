import { assertEquals } from "@std/assert";
import {
  attachGuestWorkerFactory,
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

Deno.test("guest worker factory starts the built bootstrap module", () => {
  const coordinator = new EventTarget() as unknown as Worker;
  const started: Array<[string, WorkerOptions | undefined]> = [];
  const guest = {
    postMessage() {},
    terminate() {},
  } as unknown as Worker;
  attachGuestWorkerFactory(coordinator, {
    origin: "http://127.0.0.1:4173",
    createWorker: (url, options) => {
      started.push([url, options]);
      return guest;
    },
  });
  // WorkerHost names its bootstrap by source file; the page serves the build.
  coordinator.dispatchEvent(
    Object.assign(new Event("message"), {
      data: {
        type: CREATE_GUEST_WORKER,
        url: "http://127.0.0.1:4173/worker_bootstrap.ts",
        options: { type: "classic" },
      },
      ports: [new MessageChannel().port2],
    }),
  );
  assertEquals(started, [
    ["http://127.0.0.1:4173/worker_bootstrap.js", { type: "module" }],
  ]);
});
