import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { bootAshSession, typeCommand } from "./ash_harness.ts";

// A boot says what is in this Linux: to the page, above the shell's first
// prompt, and in /etc/motd; and says it again once pkg lists more.
Deno.test({
  name: "a boot says what is in this Linux, and says it again after an install",
  // A spawned process leaves its exec sweep's timer (src/boot.ts), as in
  // boot_test's process tests.
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const session = await bootAshSession({ requireArtifacts: true });
  if (session === undefined) {
    throw new Error("required session unexpectedly skipped");
  }
  try {
    const { term, remarks } = session;
    assertEquals(remarks.length, 1, "told the page once at boot");
    const first = remarks[0];
    assert(first.startsWith("BusyBox shell"), first);
    // The image bakes these into its base outside pkg (src/image_tools.ts).
    assertStringIncludes(
      first,
      "; also zsh, make, curl, jq, sqlite3, zstd, xz",
    );
    await typeCommand(term, "true");
    assert(
      term.output().indexOf(first) >= 0 &&
        term.output().indexOf(first) < term.output().indexOf("$"),
      `printed above the first prompt: ${
        JSON.stringify(term.output().slice(0, 300))
      }`,
    );
    assertStringIncludes(await typeCommand(term, "cat /etc/motd"), first);
    // What pkg would write after installing one more package (its state
    // directory made first, should this image have none). Through the
    // session's own process, not typed: `sudo` at the terminal needs a
    // tty process group, which CI's runner does not give.
    const write = await session.process(
      `exec sudo /bin/sh -c 'mkdir -p /var/lib/yurt-pkg && printf "jq\\t1.7\\tyurt_0\\n" >> /var/lib/yurt-pkg/installed.list'`,
      { maxOutputBytes: 4096 },
    );
    const status = await write.exited;
    const wrote = `${JSON.stringify(status)} ${
      new TextDecoder().decode(write.takeStdout())
    }${new TextDecoder().decode(write.takeStderr())}`;
    assertEquals(
      typeof status === "number" ? status : status.code,
      0,
      `the write: ${wrote}`,
    );
    session.refreshRemark();
    assertEquals(
      remarks.length,
      2,
      `said again once it changed: remarks ${
        JSON.stringify(remarks)
      }; the write said ${JSON.stringify(wrote.slice(-600))}`,
    );
    assert(remarks[1] !== first, remarks[1]);
    // jq is pkg's now: counted among its packages, no longer "also".
    assertStringIncludes(
      remarks[1],
      "; also zsh, make, curl, sqlite3, zstd, xz",
    );
    assertStringIncludes(await typeCommand(term, "cat /etc/motd"), remarks[1]);
    // Unchanged: not said again.
    session.refreshRemark();
    assertEquals(remarks.length, 2);
  } finally {
    session.stop();
  }
});
