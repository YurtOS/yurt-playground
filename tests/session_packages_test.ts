import { assertEquals, assertRejects } from "@std/assert";
import {
  HEARTBEAT,
  runStaged,
  withHeartbeat,
} from "../src/session_packages.ts";
import { STAGING_DIR } from "../src/packages.ts";
import type { SpawnedProcess } from "../src/executions.ts";

const enc = new TextEncoder();

/** A session whose first process is the run (its output grows by `chunks`,
 * one per `everyMs`, then it exits 0, or never when `hang`); every later
 * process is the cleanup and exits at once. */
function fakeSession(
  chunks: { stdout?: string; stderr?: string }[],
  everyMs: number,
  hang = false,
) {
  const lines: string[] = [];
  let stdout = "";
  let stderr = "";
  const process = (line: string): Promise<SpawnedProcess> => {
    lines.push(line);
    if (lines.length > 1) {
      return Promise.resolve({
        pid: lines.length,
        exited: Promise.resolve(0),
        takeStdout: () => new Uint8Array(),
        takeStderr: () => new Uint8Array(),
      });
    }
    const exited = new Promise<number>((resolve) => {
      let i = 0;
      const timer = setInterval(() => {
        if (i < chunks.length) {
          stdout += chunks[i].stdout ?? "";
          stderr += chunks[i].stderr ?? "";
          i++;
          return;
        }
        clearInterval(timer);
        // A hung run: silent from here on, and never done.
        if (!hang) resolve(0);
      }, everyMs);
    });
    return Promise.resolve({
      pid: 1,
      exited,
      takeStdout: () => enc.encode(stdout),
      takeStderr: () => enc.encode(stderr),
      peek: () => ({ stdout: enc.encode(stdout), stderr: enc.encode(stderr) }),
    });
  };
  return { session: { process, writeFiles: () => {} }, lines };
}

Deno.test("a watched run beats beside the script, and the beats are not its output", async () => {
  const { session, lines } = fakeSession([
    { stderr: HEARTBEAT },
    { stderr: HEARTBEAT },
    { stdout: "install greet 0.1.0-yurt_0\n", stderr: HEARTBEAT },
    { stderr: `Error: failed to fetch archive for greet\n${HEARTBEAT}` },
  ], 10);
  let alive = 0;
  const result = await runStaged(session, [], "pkg install greet", {
    alive: () => alive++,
    signal: new AbortController().signal,
  }, 5);
  assertEquals(result, {
    code: 0,
    stdout: "install greet 0.1.0-yurt_0\n",
    stderr: "Error: failed to fetch archive for greet\n",
  });
  // Every growth of the output was seen as the guest working.
  assertEquals(alive >= 3, true, `alive ${alive}`);
  assertEquals(
    lines[0],
    `exec /bin/sh -c '${
      withHeartbeat("pkg install greet").replaceAll("'", "'\\''")
    }'`,
  );
  assertEquals(
    lines[1],
    `exec /bin/sh -c 'sudo rm -rf '\\''${STAGING_DIR}'\\'''`,
  );
});

Deno.test("the heartbeat lives as long as the script's shell, and the script's status is kept", () => {
  const script = withHeartbeat("exit 3");
  assertEquals(script.split("\n"), [
    `( while kill -0 $$ 2>/dev/null; do printf '${HEARTBEAT}' >&2; sleep 2; done ) &`,
    "beat=$!",
    "/bin/sh -c 'exit 3'",
    "s=$?",
    'kill "$beat" 2>/dev/null',
    "exit $s",
  ]);
});

Deno.test("an unwatched run has no heartbeat", async () => {
  const { session, lines } = fakeSession([{ stdout: "ok\n" }], 5);
  const result = await runStaged(session, [], "pkg install greet");
  assertEquals(result.stdout, "ok\n");
  assertEquals(lines[0], "exec /bin/sh -c 'pkg install greet'");
});

Deno.test("a run the install gave up on stops being watched", async () => {
  // It beats twice, then nothing, and never exits.
  const { session } = fakeSession(
    [{ stderr: HEARTBEAT }, { stderr: HEARTBEAT }],
    10,
    true,
  );
  const giveUp = new AbortController();
  let alive = 0;
  const run = runStaged(session, [], "pkg install greet", {
    alive: () => alive++,
    signal: giveUp.signal,
  }, 5);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const seen = alive;
  assertEquals(seen >= 1, true);
  giveUp.abort();
  await assertRejects(() => run, Error, "stopped watching");
  // Deno's leak check fails the test if the poll were still running.
});
