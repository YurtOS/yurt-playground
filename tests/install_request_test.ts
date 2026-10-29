import { assertEquals, assertRejects } from "@std/assert";
import { InstallsStopped, packageRequests } from "../src/install_request.ts";

const SILENCE_MS = 50;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

Deno.test("an install the coordinator never answers fails once it has been silent too long", async () => {
  const sent: [number, string][] = [];
  const installs = packageRequests(
    (req, name) => sent.push([req, name]),
    SILENCE_MS,
  );
  const started = Date.now();
  await assertRejects(
    () => installs.install("go", () => {}),
    Error,
    "The sandbox stopped responding while installing go. Reload the page",
  );
  assertEquals(sent, [[1, "go"]]);
  if (Date.now() - started < SILENCE_MS) {
    throw new Error("gave up before the silence deadline");
  }
});

Deno.test("a progress or reply that comes after the deadline is ignored", async () => {
  const installs = packageRequests(() => {}, SILENCE_MS);
  const shown: string[] = [];
  const outcome = installs.install("go", (text) => shown.push(text));
  installs.heard();
  installs.answer({ type: "pkg-progress", req: 1, text: "go: resolving" });
  await assertRejects(() => outcome, Error, "stopped responding");
  // The coordinator comes back after all: neither its progress nor its
  // reply touches the failed install.
  installs.heard();
  installs.answer({ type: "pkg-progress", req: 1, text: "go: installing" });
  installs.answer({ type: "pkg-reply", req: 1, ok: true, value: "done" });
  assertEquals(shown, ["go: resolving"]);
});

Deno.test("any coordinator message keeps an install waiting past the deadline", async () => {
  const installs = packageRequests(() => {}, SILENCE_MS);
  const outcome = installs.install("go", () => {});
  // Queued behind another install: the coordinator talks, about other
  // things, for several silence windows.
  for (let i = 0; i < 8; i++) {
    await sleep(SILENCE_MS / 2);
    installs.heard();
  }
  installs.answer({ type: "pkg-reply", req: 1, ok: true, value: "go out" });
  assertEquals(await outcome, "go out");
});

Deno.test("an answered install ends with its reply and leaves no timer", async () => {
  const installs = packageRequests(() => {}, SILENCE_MS);
  const shown: string[] = [];
  const ok = installs.install("go", (text) => shown.push(text));
  installs.answer({ type: "pkg-progress", req: 1, text: "go: resolving" });
  installs.answer({ type: "pkg-reply", req: 1, ok: true, value: "go out" });
  assertEquals(await ok, "go out");
  assertEquals(shown, ["go: resolving"]);
  const failed = installs.install("nope", () => {});
  installs.answer({
    type: "pkg-reply",
    req: 2,
    ok: false,
    error: "no package named nope",
  });
  await assertRejects(() => failed, Error, "no package named nope");
  // The test sanitizer fails this test if either install left its timer.
});

Deno.test("after a deadline, a second install is refused without posting to the coordinator", async () => {
  const sent: string[] = [];
  const installs = packageRequests((_, name) => sent.push(name), SILENCE_MS);
  await assertRejects(
    () => installs.install("go", () => {}),
    InstallsStopped,
    "stopped responding while installing go",
  );
  // The coordinator speaks again, but the sandbox is not trusted again.
  installs.heard();
  await assertRejects(
    () => installs.install("jq", () => {}),
    InstallsStopped,
    "stopped responding while installing go",
  );
  assertEquals(sent, ["go"]);
});

Deno.test("a coordinator that fails ends the install in flight with its error, and takes no more", async () => {
  const sent: string[] = [];
  const installs = packageRequests((_, name) => sent.push(name), SILENCE_MS);
  const outcome = installs.install("go", () => {});
  installs.failAll("coordinator worker failed: out of memory");
  await assertRejects(
    () => outcome,
    InstallsStopped,
    "coordinator worker failed: out of memory",
  );
  await assertRejects(
    () => installs.install("jq", () => {}),
    InstallsStopped,
    "coordinator worker failed: out of memory",
  );
  assertEquals(sent, ["go"]);
  // The test sanitizer fails this test if the failed install left its timer.
});
