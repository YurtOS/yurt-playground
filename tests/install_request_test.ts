import { assert, assertEquals, assertRejects } from "@std/assert";
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
  // The worker's own error, and the way back.
  const said =
    "coordinator worker failed: out of memory. Reload the page to start a fresh sandbox.";
  await assertRejects(() => outcome, InstallsStopped, said);
  await assertRejects(
    () => installs.install("jq", () => {}),
    InstallsStopped,
    said,
  );
  assertEquals(sent, ["go"]);
  // The test sanitizer fails this test if the failed install left its timer.
});

// The page's wiring of the above (src/page.ts), which has no DOM-free
// test of its own: each check is scoped to the code that must hold it.
const pageSource = () =>
  Deno.readTextFileSync(new URL("../src/page.ts", import.meta.url));

Deno.test("the page fails its installs when the coordinator worker fails", () => {
  const onerror = pageSource().match(
    /worker\.onerror = \(event\) => \{([^]*?)\n {2}\};/,
  );
  assert(onerror !== null, "page.ts has worker.onerror");
  assert(/installs\?\.failAll\(message\);/.test(onerror[1]), onerror[1]);
});

Deno.test("the Packages panel installs nothing more once the sandbox stopped", () => {
  const install = pageSource().match(
    /const install = async \(name: string\) => \{([^]*?)\n {2}\};/,
  );
  assert(install !== null, "page.ts has the panel's install");
  const body = install[1];
  const caught = body.match(/\} catch \(error\) \{([^]*?)\} finally \{/);
  assert(caught !== null, body);
  assert(
    /stopped = error instanceof InstallsStopped;/.test(caught[1]),
    caught[1],
  );
  const after = body.match(/\} finally \{([^]*)$/);
  assert(after !== null, body);
  assert(
    /b\.disabled = stopped \|\| b\.textContent === "Installed";/.test(
      after[1],
    ),
    after[1],
  );
  assert(/busy \|\| stopped\) return;/.test(body), body);
});
