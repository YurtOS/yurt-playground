import { assertEquals } from "@std/assert";
import { announceSandbox, anotherSandboxRunning } from "../src/tab_presence.ts";

// Two playground tabs in one browser share the CPU, and a second boot took
// 140 s next to a running one with nothing on the page to say why
// (yurt-playground#84). A tab with a sandbox answers the others' question.

Deno.test("a tab with no neighbour hears nothing and proceeds", async () => {
  assertEquals(await anotherSandboxRunning(100, "yurt-test-alone"), false);
});

Deno.test("a tab that announced its sandbox answers a newcomer", async () => {
  const stop = announceSandbox("yurt-test-pair");
  try {
    assertEquals(await anotherSandboxRunning(1000, "yurt-test-pair"), true);
  } finally {
    stop();
  }
});
