import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { bootAshSession, typeCommand } from "./ash_harness.ts";

// A boot says what is in this Linux: to the page, above the shell's first
// prompt, and in /etc/motd; and says it again once pkg lists more.
Deno.test("a boot says what is in this Linux, and says it again after an install", async () => {
  const session = await bootAshSession({ requireArtifacts: true });
  if (session === undefined) {
    throw new Error("required session unexpectedly skipped");
  }
  try {
    const { term, remarks } = session;
    assertEquals(remarks.length, 1, "told the page once at boot");
    const first = remarks[0];
    assert(first.startsWith("BusyBox shell"), first);
    await typeCommand(term, "true");
    assert(
      term.output().indexOf(first) >= 0 &&
        term.output().indexOf(first) < term.output().indexOf("$"),
      `printed above the first prompt: ${
        JSON.stringify(term.output().slice(0, 300))
      }`,
    );
    assertStringIncludes(await typeCommand(term, "cat /etc/motd"), first);
    // What pkg would write after installing one more package.
    await typeCommand(
      term,
      "printf 'jq\\t1.7\\tyurt_0\\n' | sudo tee -a /var/lib/yurt-pkg/installed.list >/dev/null",
    );
    session.refreshRemark();
    assertEquals(remarks.length, 2, "said again once it changed");
    assert(remarks[1] !== first, remarks[1]);
    assertStringIncludes(await typeCommand(term, "cat /etc/motd"), remarks[1]);
    // Unchanged: not said again.
    session.refreshRemark();
    assertEquals(remarks.length, 2);
  } finally {
    session.stop();
  }
});
