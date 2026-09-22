import { assertEquals } from "@std/assert";
import {
  announceSandbox,
  anotherSandboxRunning,
  whileAnotherSandboxRuns,
} from "../src/tab_presence.ts";

// Two playground tabs in one browser share the CPU, and a second boot took
// 140 s next to a running one with nothing on the page to say why
// (yurt-playground#84). A tab with a sandbox answers the others' question.

/** A neighbour is another tab, so it answers under its own name: within one
 *  process the module's `SELF` would make its answer this tab's own. */
const NEIGHBOUR = "neighbour-tab";

Deno.test("a tab with no neighbour hears nothing and proceeds", async () => {
  assertEquals(await anotherSandboxRunning(100, "yurt-test-alone"), false);
});

Deno.test("a tab that announced its sandbox answers a newcomer", async () => {
  const stop = announceSandbox("yurt-test-pair", NEIGHBOUR);
  try {
    assertEquals(await anotherSandboxRunning(1000, "yurt-test-pair"), true);
  } finally {
    stop();
  }
});

// yurt-playground#134: a tab hears its own announcement, so a second ask
// always found "another" sandbox -- this one.
Deno.test("a tab does not hear its own announcement", async () => {
  const stop = announceSandbox("yurt-test-self");
  try {
    assertEquals(await anotherSandboxRunning(300, "yurt-test-self"), false);
  } finally {
    stop();
  }
});

// ... which is why the note told the reader to close the other tab and then
// kept saying it was there.
Deno.test("the note is taken down once the neighbour is gone", async () => {
  const stopNeighbour = announceSandbox("yurt-test-watch", NEIGHBOUR);
  const stopSelf = announceSandbox("yurt-test-watch");
  let gone = false;
  const stopWatching = whileAnotherSandboxRuns(
    () => gone = true,
    60,
    "yurt-test-watch",
    30,
  );
  try {
    await new Promise((r) => setTimeout(r, 400));
    assertEquals(gone, false, "the neighbour is still there");
    stopNeighbour();
    await new Promise((r) => setTimeout(r, 400));
    assertEquals(gone, true, "the neighbour left and the note stayed");
  } finally {
    stopWatching();
    stopNeighbour();
    stopSelf();
  }
});
