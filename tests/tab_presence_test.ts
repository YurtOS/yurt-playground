import { assertEquals } from "@std/assert";
import {
  announceSandbox,
  anotherSandboxRunning,
  watchForAnotherSandbox,
  whileAnotherSandboxRuns,
} from "../src/tab_presence.ts";

// Two playground tabs in one browser share the CPU, and a second boot took
// 140 s next to a running one with nothing on the page to say why
// (yurt-playground#84). A tab with a sandbox answers the others' question.

/** Use a separate channel object to behave like an independently loaded tab. */
function neighbour(name: string): () => void {
  const channel = new BroadcastChannel(name);
  channel.addEventListener(
    "message",
    (event: MessageEvent<{ type: string }>) => {
      if (event.data?.type === "who") channel.postMessage({ type: "here" });
    },
  );
  return () => channel.close();
}

Deno.test("a tab with no neighbour hears nothing and proceeds", async () => {
  assertEquals(await anotherSandboxRunning(100, "yurt-test-alone"), false);
});

Deno.test("a tab that announced its sandbox answers a newcomer", async () => {
  const name = "yurt-test-pair";
  const stop = announceSandbox(name);
  const channel = new BroadcastChannel(name);
  let asking = false;
  let resolveHere: (data: unknown) => void = () => {};
  const here = new Promise<unknown>((resolve) => {
    resolveHere = resolve;
  });
  channel.addEventListener(
    "message",
    (event: MessageEvent<{ type: string }>) => {
      if (asking && event.data?.type === "here") resolveHere(event.data);
    },
  );
  try {
    assertEquals(await anotherSandboxRunning(20, name), false);
    asking = true;
    channel.postMessage({ type: "who" });
    assertEquals(await here, { type: "here" });
  } finally {
    stop();
    channel.close();
  }
});

// A single BroadcastChannel object sends and listens for both roles. Its own
// who message is not delivered back to that object.
Deno.test("announce and ask on the same name does not report itself", async () => {
  const name = "yurt-test-self";
  const stop = announceSandbox(name);
  try {
    assertEquals(await anotherSandboxRunning(100, name), false);
  } finally {
    stop();
  }
});

Deno.test("a raw neighbour reply without a sender field counts", async () => {
  const name = "yurt-test-raw-neighbour";
  const stopNeighbour = neighbour(name);
  try {
    assertEquals(await anotherSandboxRunning(300, name), true);
  } finally {
    stopNeighbour();
  }
});

Deno.test("stopping one role keeps the shared channel open for another", async () => {
  const name = "yurt-test-shared-channel-lifetime";
  const stopNeighbour = neighbour(name);
  const probe = anotherSandboxRunning(300, name);
  const stopAnnouncing = announceSandbox(name);
  try {
    stopAnnouncing();
    assertEquals(await probe, true);
  } finally {
    stopAnnouncing();
    stopNeighbour();
  }
});

Deno.test("stopping the initial probe suppresses its delayed warning", async () => {
  const name = "yurt-test-stopped-probe";
  const channel = new BroadcastChannel(name);
  channel.addEventListener(
    "message",
    (event: MessageEvent<{ type: string }>) => {
      if (event.data?.type === "who") {
        setTimeout(() => channel.postMessage({ type: "here" }), 25);
      }
    },
  );
  let shown = 0;
  let hidden = 0;
  const stop = watchForAnotherSandbox(
    () => shown++,
    () => hidden++,
    { intervalMs: 20, name, timeoutMs: 100 },
  );
  try {
    stop();
    await new Promise((resolve) => setTimeout(resolve, 60));
    assertEquals(shown, 0, "a stopped in-flight probe must not show the note");
    assertEquals(hidden, 0);
  } finally {
    stop();
    channel.close();
  }
});

Deno.test("neighbour silence hides the warning only once", async () => {
  const name = "yurt-test-warning-silence";
  const stopNeighbour = neighbour(name);
  let shown = 0;
  let hidden = 0;
  const stop = watchForAnotherSandbox(
    () => shown++,
    () => hidden++,
    { intervalMs: 20, name, timeoutMs: 10 },
  );
  try {
    await new Promise((resolve) => setTimeout(resolve, 30));
    assertEquals(shown, 1);
    stopNeighbour();
    await new Promise((resolve) => setTimeout(resolve, 120));
    assertEquals(hidden, 1, "three silent rounds hide the note once");
    stop();
    assertEquals(hidden, 1, "stopping after silence does not hide twice");
  } finally {
    stop();
    stopNeighbour();
  }
});

Deno.test("stopping a visible warning hides it", async () => {
  const name = "yurt-test-warning-stop";
  const stopNeighbour = neighbour(name);
  let shown = 0;
  let hidden = 0;
  const stop = watchForAnotherSandbox(
    () => shown++,
    () => hidden++,
    { intervalMs: 100, name, timeoutMs: 100 },
  );
  try {
    await new Promise((resolve) => setTimeout(resolve, 15));
    assertEquals(shown, 1);
    stop();
    assertEquals(hidden, 1);
    stop();
    assertEquals(hidden, 1, "stop is idempotent");
  } finally {
    stop();
    stopNeighbour();
  }
});

// ... which is why the note told the reader to close the other tab and then
// kept saying it was there.
Deno.test("the note is taken down once the neighbour is gone", async () => {
  const name = "yurt-test-watch";
  const stopNeighbour = neighbour(name);
  let gone = false;
  const stopWatching = whileAnotherSandboxRuns(
    () => gone = true,
    60,
    name,
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
  }
});

// yurt-playground#134, review: one silent round is not evidence. The answer
// needs the *other* tab's main thread, and that tab is busy by definition --
// it is why the note is up. A single long task there would otherwise erase a
// warning that is still true, with no way back.
Deno.test("a single silent round does not take the note down", async () => {
  const name = "yurt-test-patient";
  const stopNeighbour = neighbour(name);
  let gone = 0;
  // Three rounds of silence required; the neighbour goes quiet for one.
  const stopWatching = whileAnotherSandboxRuns(
    () => gone++,
    40,
    name,
    20,
    3,
  );
  try {
    await new Promise((r) => setTimeout(r, 200));
    assertEquals(gone, 0, "answered rounds must not count");
    stopNeighbour();
    await new Promise((r) => setTimeout(r, 20));
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
