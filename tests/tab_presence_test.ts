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
    1,
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

// yurt-playground#134, review: one silent round is not evidence. The answer
// needs the *other* tab's main thread, and that tab is busy by definition --
// it is why the note is up. A single long task there would otherwise erase a
// warning that is still true, with no way back.
Deno.test("a single silent round does not take the note down", async () => {
  const stopNeighbour = announceSandbox("yurt-test-patient", NEIGHBOUR);
  let gone = 0;
  // Three rounds of silence required; the neighbour goes quiet for one.
  const stopWatching = whileAnotherSandboxRuns(
    () => gone++,
    40,
    "yurt-test-patient",
    20,
    3,
  );
  try {
    await new Promise((r) => setTimeout(r, 200));
    assertEquals(gone, 0, "answered rounds must not count");
    stopNeighbour();
    await new Promise((r) => setTimeout(r, 90));
    assertEquals(gone, 0, "one silent round is not enough");
    await new Promise((r) => setTimeout(r, 300));
    assertEquals(gone, 1, "three silent rounds must take it down, once");
  } finally {
    stopWatching();
    stopNeighbour();
  }
});

// ... and the watcher stops meaning it once it is stopped: `clearInterval`
// cannot cancel a probe already in flight.
Deno.test("a stopped watcher does not report later", async () => {
  let gone = 0;
  const stopWatching = whileAnotherSandboxRuns(
    () => gone++,
    20,
    "yurt-test-stopped",
    200,
    1,
  );
  await new Promise((r) => setTimeout(r, 40));
  stopWatching();
  await new Promise((r) => setTimeout(r, 400));
  assertEquals(gone, 0, "a probe in flight at stop() still reported");
});
