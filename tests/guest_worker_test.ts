import { assertEquals, assertThrows } from "@std/assert";
import {
  GUEST_WORKER_PATH,
  GuestWorkerRefused,
  guestWorkerStart,
} from "../src/guest_worker.ts";
import {
  CREATE_GUEST_WORKER,
  parseCreateGuestWorkerMessage,
} from "../src/page_worker_bridge.ts";

const ORIGIN = "http://127.0.0.1:4173";

Deno.test("guest workers are module scripts at the bundled bootstrap", () => {
  for (
    const requested of [
      "./worker_bootstrap.ts",
      "worker_bootstrap.js",
      `${ORIGIN}/worker_bootstrap.js`,
      `${ORIGIN}/nested/worker_bootstrap.ts?v=1`,
    ]
  ) {
    const [url, options] = guestWorkerStart(requested, ORIGIN);
    assertEquals(url, `${ORIGIN}${GUEST_WORKER_PATH}`, requested);
    assertEquals(options.type, "module");
  }
});

Deno.test("anything but the same-origin bootstrap is refused", () => {
  for (
    const requested of [
      "https://evil.example/worker_bootstrap.js",
      "//evil.example/worker_bootstrap.js",
      "http://127.0.0.1:4174/worker_bootstrap.js",
      "blob:http://127.0.0.1:4173/0f2a",
      "data:text/javascript,postMessage(1)",
      "./coordinator.bundle.js",
      "./worker_bootstrap.js.evil",
      "javascript:alert(1)",
      "",
    ]
  ) {
    assertThrows(
      () => guestWorkerStart(requested, ORIGIN),
      GuestWorkerRefused,
      undefined,
      requested,
    );
  }
});

Deno.test("only a well-formed create request crosses the coordinator boundary", () => {
  assertEquals(
    parseCreateGuestWorkerMessage({
      type: CREATE_GUEST_WORKER,
      url: "./worker_bootstrap.ts",
      options: { type: "module" },
    }),
    { type: CREATE_GUEST_WORKER, url: "./worker_bootstrap.ts" },
  );
  for (
    const data of [
      null,
      undefined,
      "yurt-create-guest-worker",
      { type: "other", url: "./worker_bootstrap.ts" },
      { type: CREATE_GUEST_WORKER },
      { type: CREATE_GUEST_WORKER, url: 42 },
      {
        type: CREATE_GUEST_WORKER,
        url: new URL("http://a/worker_bootstrap.js"),
      },
    ]
  ) {
    assertEquals(parseCreateGuestWorkerMessage(data), undefined);
  }
});
