import { assertStringIncludes } from "@std/assert";
import { bootAshSession, typeCommand, waitFor } from "./ash_harness.ts";

// The banner offers zsh, and its line editor (zle) is what a person meets
// first: the prompt is drawn before any key is read, so "zsh starts" says
// nothing. The first key typed runs self-insert, which runs zsh's hooks
// through function pointers -- on wasm a hook registered with the wrong
// signature traps right there (yurt-ports#284), and the shell reported
// `Illegal instruction` (Chrome 156, Safari 27) or `Segmentation fault`
// (older V8) and dropped back to ash. So type a key, then a command, then leave.
Deno.test("playground's zsh survives the first key and exits cleanly", async () => {
  const session = await bootAshSession({ requireArtifacts: true });
  if (session === undefined) {
    throw new Error("required zsh session unexpectedly skipped");
  }
  const { term } = session;
  const faults = ["Illegal instruction", "Segmentation fault"];
  // A dead zsh never echoes: fail on the fault, not 60 s later on a timeout.
  const alive = (from: number, done: (seen: string) => boolean) => () => {
    const seen = term.output().slice(from);
    for (const fault of faults) {
      if (seen.includes(fault)) {
        throw new Error(`zsh died: ${JSON.stringify(seen)}`);
      }
    }
    return done(seen);
  };
  try {
    const before = term.output().length;
    // -f: no rc files, so only zsh itself is under test.
    term.type("zsh -f\n");
    // zle turns bracketed paste on once it is ready to read a key.
    await waitFor(
      alive(before, (seen) => seen.includes("\x1b[?2004h")),
      "zsh line editor",
      60_000,
    );
    const typed = term.output().length;
    term.type("echo zsh-");
    // zle echoes the inserted text as it consumes each key.
    await waitFor(
      alive(typed, (seen) => seen.includes("echo zsh-")),
      "zsh to echo the typed keys",
      60_000,
    );
    term.type("alive\n");
    await waitFor(
      alive(typed, (seen) => /\r?\nzsh-alive\r?\n/.test(seen)),
      "zsh to run the command",
      60_000,
    );
    term.type("exit\n");
    await waitFor(
      alive(typed, (seen) => /\$ $/.test(seen)),
      "ash prompt after zsh exits",
      60_000,
    );
    assertStringIncludes(await typeCommand(term, "echo rc=$?"), "rc=0");
  } finally {
    session.stop();
  }
});
