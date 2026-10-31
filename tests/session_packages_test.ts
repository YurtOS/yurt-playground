import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  type BootedSession,
  HEARTBEAT,
  recoverScript,
  runStaged,
  withHeartbeat,
  workerPackageHost,
} from "../src/session_packages.ts";
import { relayedInstallScript, STAGING_DIR } from "../src/packages.ts";
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

/** Run `withHeartbeat(script)` in the host's sh, beating every 0.2 s: on
 * Linux (CI: dash) through /proc, like the guest's ash; on macOS through
 * pgrep. The beats seen by each time, the exit code, and stderr. */
async function hostHeartbeat(
  script: string,
  marks: number[],
): Promise<{ beats: number[]; code: number; stderr: string }> {
  const child = new Deno.Command("/bin/sh", {
    args: ["-c", withHeartbeat(script, 0.2, "")],
    stdout: "null",
    stderr: "piped",
  }).spawn();
  let stderr = "";
  const reading = (async () => {
    for await (
      const chunk of child.stderr.pipeThrough(new TextDecoderStream())
    ) {
      stderr += chunk;
    }
  })();
  const beats: number[] = [];
  const start = Date.now();
  for (const mark of marks) {
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(0, mark - (Date.now() - start)))
    );
    beats.push(stderr.split(HEARTBEAT).length - 1);
  }
  const { code } = await child.status;
  await reading;
  return { beats, code, stderr: stderr.replaceAll(HEARTBEAT, "") };
}

Deno.test("the guest beats while its shell waits on a child, and stops when the child is gone", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const fifo = `${dir}/fifo`;
    // 1.5 s with a child (`sleep`), then the shell blocks with no child at
    // all -- as in yurtos-kernel#4170, where pkg vanished and the shell
    // slept on -- until the fifo is written (at 3.5 s), then exits 3.
    const run = hostHeartbeat(
      `sleep 1.5; mkfifo '${fifo}'; read x < '${fifo}'; echo done >&2; exit 3`,
      [1400, 2000, 3000],
    );
    setTimeout(() => {
      new Deno.Command("/bin/sh", { args: ["-c", `echo go > '${fifo}'`] })
        .spawn();
    }, 3500);
    const { beats, code, stderr } = await run;
    // Beating while `sleep` ran...
    assertEquals(beats[0] >= 3, true, `beats ${beats}`);
    // ...then at most one more (the one under way), and none after.
    assertEquals(beats[1] - beats[0] <= 1, true, `beats ${beats}`);
    assertEquals(beats[2], beats[1], `beats ${beats}`);
    // The script's own status and stderr come through.
    assertEquals(code, 3);
    assertEquals(stderr, "done\n");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a child that exited unreaped (a zombie) is no pkg at work: no beat", async () => {
  // The script's shell becomes `sleep 3` (exec), whose own child `sleep
  // 0.2` exits and is never reaped: after 0.2 s the only child is a zombie
  // -- what a lost child exit would leave.
  const { beats, code } = await hostHeartbeat(
    "sleep 0.2 & exec sleep 3",
    [1000, 2500],
  );
  assertEquals(beats[1] - beats[0], 0, `beats ${beats}`);
  assertEquals(code, 0);
});

Deno.test("an install that has given up stages and runs nothing", async () => {
  const { session, lines } = fakeSession([{ stdout: "ok\n" }], 5);
  const giveUp = new AbortController();
  giveUp.abort();
  let written = 0;
  await assertRejects(
    () =>
      runStaged(
        { ...session, writeFiles: () => written++ },
        [],
        "pkg install greet",
        { alive: () => {}, signal: giveUp.signal },
        5,
      ),
    Error,
    "stopped watching",
  );
  assertEquals(lines, []);
  assertEquals(written, 0);
});

Deno.test("a beat split around a multibyte character leaves the character whole", async () => {
  const bytes = new TextEncoder().encode("é\n");
  const split = new Uint8Array([bytes[0], 0x1e, bytes[1], bytes[2]]);
  const { session } = fakeSession([], 5);
  const real = session.process;
  const result = await runStaged(
    {
      ...session,
      process: async (line) => ({
        ...(await real(line)),
        takeStderr: () => split,
      }),
    },
    [],
    "pkg install greet",
    { alive: () => {}, signal: new AbortController().signal },
    5,
  );
  assertEquals(result.stderr, "é\n");
});

Deno.test("an unwatched run has no heartbeat", async () => {
  const { session, lines } = fakeSession([{ stdout: "ok\n" }], 5);
  const result = await runStaged(session, [], "pkg install greet");
  assertEquals(result.stdout, "ok\n");
  assertEquals(lines[0], "exec /bin/sh -c 'pkg install greet'");
});

Deno.test("a run the install gave up on stops being watched", async () => {
  // It beats twice, then nothing, and never exits.
  const { session, lines } = fakeSession(
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
  // Deno's leak check fails the test if the poll were still running; and
  // no cleanup is spawned into a sandbox that may not run it.
  assertEquals(lines.length, 1);
});

Deno.test("the worker's host runs pkg recover as root, watched, staging nothing", async () => {
  const { session, lines } = fakeSession([
    { stderr: HEARTBEAT },
    { stdout: "recovered 0001\n" },
  ], 10);
  const host = workerPackageHost(session as unknown as BootedSession);
  const result = await host.recover!({
    alive: () => {},
    signal: new AbortController().signal,
  });
  // The beats are not its output; it runs with the heartbeat (watched),
  // and no clean-up of the staging copy follows it.
  assertEquals(result, { code: 0, stdout: "recovered 0001\n", stderr: "" });
  assertEquals(lines, [
    `exec /bin/sh -c '${
      withHeartbeat(recoverScript()).replaceAll("'", "'\\''")
    }'`,
  ]);
});

Deno.test("pkg recover alone gives the heartbeat no child to see; in a shell that waits on it, it beats", async () => {
  // The guest's BusyBox ash, given `sh -c` with one simple command, execs
  // it in place of the shell, which then has no child: the loop beats
  // nothing, and a recovery waiting on pkg's lock would look stopped.
  // Host shells differ (Ubuntu's dash keeps the shell here), so the lone
  // case says `exec` itself. The recovery's script keeps the shell on
  // any of them: its last command is the `exit` builtin.
  const lone = await hostHeartbeat("exec sleep 1.2", [1000]);
  assertEquals(lone.beats[0], 0, `beats ${lone.beats}`);
  const kept = await hostHeartbeat(recoverScript("sleep 1.2"), [1000]);
  assertEquals(kept.beats[0] >= 3, true, `beats ${kept.beats}`);
  assertEquals(recoverScript(), "sudo pkg recover; exit $?");
});

Deno.test("the relayed install keeps beating through its last command", async () => {
  // `pkg` replaced by a sleep: both of its commands take 1.2 s. Beats are
  // counted at 1.0 s (the update) and in the install, from 1.6 s to 2.2 s.
  const script = relayedInstallScript("greet", "sleep 1.2; :");
  const { beats } = await hostHeartbeat(script, [1000, 1600, 2200]);
  assert(beats[0] >= 3, `beats ${beats}`);
  assert(beats[2] - beats[1] >= 2, `beats ${beats}`);
  // What an `exec` of the last command would do: nothing beats after it.
  const execed = await hostHeartbeat(
    "sleep 1.2; : update || exit 1\nexec sleep 1.2",
    [1000, 1600, 2200],
  );
  assertEquals(execed.beats[2] - execed.beats[1], 0, `beats ${execed.beats}`);
});
