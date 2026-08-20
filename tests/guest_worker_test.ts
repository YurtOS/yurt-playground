import { assertEquals } from "@std/assert";
import { guestWorkerStart } from "../src/guest_worker.ts";

Deno.test("guest workers are module scripts at an absolute URL", () => {
  const [url, options] = guestWorkerStart(
    "./worker_bootstrap.ts",
    "http://127.0.0.1:4173",
  );
  assertEquals(url, "http://127.0.0.1:4173/worker_bootstrap.js");
  assertEquals(options.type, "module");
});
