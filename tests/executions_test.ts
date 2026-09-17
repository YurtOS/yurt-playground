import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  buildExecLine,
  ExecutionRegistry,
  MAX_ACTIVE_EXECUTIONS,
  signalNumber,
  type SpawnedProcess,
} from "../src/executions.ts";

/** A process that says what it was told to and exits when asked. */
class FakeProcess implements SpawnedProcess {
  static next = 100;
  pid = FakeProcess.next++;
  stdinFed: Uint8Array[] = [];
  stdinClosed = false;
  #out: Uint8Array[] = [];
  #err: Uint8Array[] = [];
  #resolve!: (code: number) => void;
  exited: Promise<number> = new Promise((resolve) => this.#resolve = resolve);
  constructor(readonly line: string) {}
  feedStdin(bytes: Uint8Array) {
    this.stdinFed.push(bytes);
  }
  closeStdin() {
    this.stdinClosed = true;
  }
  say(text: string, stream: "out" | "err" = "out") {
    (stream === "out" ? this.#out : this.#err).push(
      new TextEncoder().encode(text),
    );
  }
  takeStdout() {
    return take(this.#out);
  }
  takeStderr() {
    return take(this.#err);
  }
  exit(code: number) {
    this.#resolve(code);
  }
}

function take(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks.splice(0)) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

function registry(options: { killExits?: boolean } = {}) {
  const spawned: FakeProcess[] = [];
  const signals: Array<[number, number]> = [];
  const reg = new ExecutionRegistry(
    (line) => {
      const p = new FakeProcess(line);
      spawned.push(p);
      return Promise.resolve(p);
    },
    (pid, signal) => {
      signals.push([pid, signal]);
      if (options.killExits !== false) {
        spawned.find((p) => p.pid === pid)?.exit(137);
      }
      return Promise.resolve();
    },
    { pollMs: 5 },
  );
  return { reg, spawned, signals };
}

Deno.test("the exec line carries cwd, a merged env with removals, and the command under its own sh -c", () => {
  assertEquals(
    buildExecLine("echo $A", {
      cwd: "/tmp/it's",
      env: { A: "x y", B: "", GONE: null },
    }),
    `cd '/tmp/it'\\''s' || exit 126; exec env 'A=x y' 'B=' -u GONE sh -c 'echo $A'`,
  );
  assertEquals(buildExecLine("true"), "exec sh -c 'true'");
  assertThrows(
    () => buildExecLine("true", { env: { "bad name": "1" } }),
    Error,
    "variable name",
  );
});

Deno.test("exec collects both streams, the status, and feeds then closes stdin", async () => {
  const { reg, spawned } = registry();
  const id = await reg.spawn("cat", { stdin: "hello" });
  const p = spawned[0];
  assertEquals(new TextDecoder().decode(p.stdinFed[0]), "hello");
  assertEquals(p.stdinClosed, true);
  p.say("hello");
  p.say("warn\n", "err");
  p.exit(3);
  const result = await reg.wait(id);
  assertEquals(result, {
    code: 3,
    signal: null,
    timedOut: false,
    stdout: "hello",
    stderr: "warn\n",
    stdoutTruncated: false,
    stderrTruncated: false,
  });
  // Read once, gone.
  assertEquals(reg.list(), []);
  await assertRejects(() => reg.wait(id), Error, "no execution");
});

Deno.test("capture stops at maxOutputBytes while the process keeps running", async () => {
  const { reg, spawned } = registry();
  const id = await reg.spawn("yes", { maxOutputBytes: 10 });
  const p = spawned[0];
  for (let i = 0; i < 100; i++) p.say("yyyy\n");
  await new Promise((r) => setTimeout(r, 30));
  p.say("more");
  p.exit(0);
  const result = await reg.wait(id);
  assertEquals(result.stdout, "yyyy\nyyyy\n");
  assertEquals(result.stdoutTruncated, true);
  assertEquals(result.stderrTruncated, false);
});

Deno.test("the deadline kills; a process that then exits reports the signal", async () => {
  const { reg, spawned, signals } = registry();
  const id = await reg.spawn("sleep 100", { timeoutMs: 20 });
  const result = await reg.wait(id);
  assertEquals(signals, [[spawned[0].pid, 9]]);
  assertEquals(result.timedOut, true);
  assertEquals("code" in result ? result.code : "stuck", null);
  assertEquals("signal" in result ? result.signal : "stuck", "SIGKILL");
});

Deno.test("a process that ignores the kill is reported stuck, kept, and released when it exits", async () => {
  const { reg, spawned } = registry({ killExits: false });
  const id = await reg.spawn("while :; do :; done", { timeoutMs: 10 });
  spawned[0].say("spinning");
  // KILL_GRACE_MS is 2 s; wait it out.
  const result = await reg.wait(id);
  assertEquals("stillRunning" in result && result.stillRunning, true);
  assertEquals("killAttempted" in result && result.killAttempted, true);
  assertEquals(result.stdout, "spinning");
  assertEquals(reg.list().map((r) => r.state), ["stuck"]);
  assertEquals(reg.active(), 1);
  spawned[0].exit(137);
  await new Promise((r) => setTimeout(r, 10));
  // Its result was read while it was stuck; the exit releases it.
  assertEquals(reg.list(), []);
  assertEquals(reg.active(), 0);
});

Deno.test("no more than the active limit; a kill by name resolves to its number", async () => {
  const { reg, spawned } = registry();
  const ids: string[] = [];
  for (let i = 0; i < MAX_ACTIVE_EXECUTIONS; i++) {
    ids.push(await reg.spawn("sleep 1"));
  }
  await assertRejects(() => reg.spawn("true"), Error, "TooManyExecutions");
  await reg.kill(ids[0], "term");
  spawned[0].exit(143);
  const result = await reg.wait(ids[0]);
  assertEquals("signal" in result ? result.signal : "stuck", "SIGTERM");
  assertEquals(signalNumber("KILL"), 9);
  assertThrows(() => signalNumber("SIGFOO"), Error, "unknown signal");
  for (const [i, id] of ids.entries()) {
    if (i === 0) continue;
    spawned[i].exit(0);
    await reg.wait(id);
  }
});
