import { assertStringIncludes } from "@std/assert";
import { bootAshSession, typeCommand } from "./ash_harness.ts";

// The page's shell must start in a UTF-8 locale. Nothing else in the image
// sets one (no /etc/profile, and the page runs /bin/sh directly, not as a
// login shell), and terminal programs check for it: btop refuses to start
// with "No UTF-8 locale detected!", and others fall back to ASCII.
Deno.test("playground shell starts with a UTF-8 locale", async () => {
  const session = await bootAshSession({ requireArtifacts: true });
  if (session === undefined) {
    throw new Error("required shell session unexpectedly skipped");
  }
  const { term } = session;
  try {
    assertStringIncludes(
      await typeCommand(term, 'echo "lang=[$LANG]"', 30_000),
      "lang=[C.UTF-8]",
    );
    // libc accepts the name, so a program's setlocale(LC_ALL, "") selects it.
    assertStringIncludes(
      await typeCommand(
        term,
        'python3 -c \'import locale; print("loc=" + locale.setlocale(locale.LC_ALL, ""))\'',
        60_000,
      ),
      "loc=C.UTF-8",
    );
  } finally {
    session.stop();
  }
});
