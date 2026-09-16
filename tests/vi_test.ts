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
    term.type(`ihello from busybox vi${ESC}`);
    // ESC alone vs. ESC starting an arrow-key sequence is disambiguated by a
    // read gap, so `:wq` must not land in the same read as the ESC that
    // leaves insert mode -- as it never does from a human's keystrokes.
    await new Promise((resolve) => setTimeout(resolve, 250));
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
