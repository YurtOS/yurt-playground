import { assertStringIncludes } from "@std/assert";
import { bootAshSession, typeCommand, waitFor } from "./ash_harness.ts";

const ESC = "\x1b";

// vi is the shell's editor (yurt-ports#88). It is a full-screen program on
// the pty -- raw mode, cursor addressing, an alternate screen -- so it is
// checked on this JS host, not only on the native runtime: insert a line,
// `:wq`, and read the file back through the shell.
Deno.test("playground's shell edits a file with vi", async () => {
  const session = await bootAshSession({ requireArtifacts: true });
  if (session === undefined) {
    throw new Error("required vi session unexpectedly skipped");
  }
  const { term } = session;
  try {
    const before = term.output().length;
    term.type("vi /tmp/vi-check.txt\n");
    // vi switches to the alternate screen and addresses the cursor; wait for
    // a cursor-position escape sequence no plain shell output contains.
    const cursorAddress = new RegExp(`${ESC}\\[\\d+;\\d+H`);
    await waitFor(
      () => cursorAddress.test(term.output().slice(before)),
      "vi screen",
      60_000,
    );
    const typed = term.output().length;
    term.type("ihello from busybox vi");
    // vi echoes the inserted text as it consumes the keystrokes.
    await waitFor(
      () => term.output().slice(typed).includes("hello from busybox vi"),
      "vi to echo the inserted text",
      60_000,
    );
    // ESC alone vs. ESC starting an arrow-key sequence is disambiguated by a
    // read gap, so `:wq` must not land in the same read as the ESC that
    // leaves insert mode -- as it never does from a human's keystrokes. A
    // fixed pause is not a gap on a slow host (CI coalesced them and vi went
    // silent), so wait for the proof that vi consumed the ESC: its status
    // line leaves insert mode and reports the buffer as modified.
    const left = term.output().length;
    term.type(ESC);
    await waitFor(
      () => term.output().slice(left).includes("[Modified]"),
      "vi to leave insert mode",
      60_000,
    );
    term.type(":wq\n");
    await waitFor(
      () => /\$ $/.test(term.output().slice(before)),
      "ash prompt after :wq",
      60_000,
    );
    assertStringIncludes(
      await typeCommand(term, "cat /tmp/vi-check.txt"),
      "hello from busybox vi",
    );
  } finally {
    session.stop();
  }
});
