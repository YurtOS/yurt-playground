import { assertEquals } from "@std/assert";
import { CREATE_GUEST_WORKER } from "../src/page_worker_bridge.ts";

Deno.test("guest-worker factory messages use a reserved type", () => {
  assertEquals(CREATE_GUEST_WORKER, "yurt-create-guest-worker");
});
