import { assertEquals, assertThrows } from "@std/assert";
import {
  applyInstalled,
  FRESH_SANDBOX,
  INSTALLED_DB_PATH,
  INSTALLED_LIST_PATH,
  installedNames,
  installedReport,
  type SandboxFiles,
} from "../src/installed_list.ts";

const LIST = "ca-certificates\t2026.9.25\tyurt_0\n" +
  "git\t2.55.0\tyurt_0\n" +
  "python\t3.14.7\tyurt_0\n";
const encode = (text: string) => new TextEncoder().encode(text);

/** A sandbox's files: `readWhole` as one VFS read answers. */
function files(have: Record<string, string>): SandboxFiles {
  return {
    readWhole: (path) =>
      Promise.resolve(
        have[path] === undefined ? undefined : encode(have[path]),
      ),
    exists: (path) => Promise.resolve(have[path] !== undefined),
  };
}

Deno.test("installedNames is the first field of each NAME<TAB>VERSION<TAB>BUILD line", () => {
  assertEquals(
    installedNames(encode(LIST)),
    ["ca-certificates", "git", "python"],
  );
  // An empty list: nothing installed.
  assertEquals(installedNames(new Uint8Array()), []);
  // A last line without its newline is still a line.
  assertEquals(installedNames(encode("rtk\t0.50.0\t1")), ["rtk"]);
  // An older pkg's row: an odd name, an empty build. Only NAME must be there.
  assertEquals(installedNames(encode("Old_Name\t1\t\n")), ["Old_Name"]);
});

Deno.test("installedNames refuses a broken list", () => {
  // pkg replaces the list whole, by a rename: a bad line is a broken list,
  // refused rather than half read.
  for (
    const bad of [
      "git 2.55.0 yurt_0\n",
      "git\t2.55.0\n",
      "git\t2.55.0\tyurt_0\textra\n",
      "\t2.55.0\tyurt_0\n",
      "git\t2.55.0\tyurt_0\n\n",
    ]
  ) {
    assertThrows(
      () => installedNames(encode(bad)),
      Error,
      "is not NAME<TAB>VERSION<TAB>BUILD",
      JSON.stringify(bad),
    );
  }
  assertThrows(
    () => installedNames(encode(LIST + "broken\n")),
    Error,
    "line 4",
  );
  // Not UTF-8: refused, not read with replacement characters.
  assertThrows(
    () => installedNames(new Uint8Array([0x67, 0xff, 0x09, 0x31, 0x09, 0x31])),
    Error,
    "pkg's installed list is broken: not UTF-8",
  );
});

Deno.test("installedReport is the list's names, or why they cannot be told", async () => {
  assertEquals(
    await installedReport(files({ [INSTALLED_LIST_PATH]: LIST })),
    { type: "pkg-installed", names: ["ca-certificates", "git", "python"] },
  );
  assertEquals(
    await installedReport(
      files({ [INSTALLED_LIST_PATH]: "", [INSTALLED_DB_PATH]: "db" }),
    ),
    { type: "pkg-installed", names: [] },
  );
  // No list and no database: no pkg state, nothing installed.
  assertEquals(await installedReport(files({})), {
    type: "pkg-installed",
    names: [],
  });
  // A database without a list (an older pkg, or one whose write of the
  // list failed): unknown, never nothing installed.
  assertEquals(
    await installedReport(files({ [INSTALLED_DB_PATH]: "db" })),
    { type: "pkg-installed", error: "pkg's installed list is not there" },
  );
  // A broken list, and a read that fails (a list too big for one read).
  assertEquals(
    await installedReport(files({ [INSTALLED_LIST_PATH]: "broken\n" })),
    {
      type: "pkg-installed",
      error: "pkg's installed list: line 1 is not NAME<TAB>VERSION<TAB>BUILD",
    },
  );
  assertEquals(
    await installedReport({
      readWhole: () =>
        Promise.reject(new Error("/x does not fit one read (65000 bytes)")),
      exists: () => Promise.resolve(true),
    }),
    {
      type: "pkg-installed",
      error: "/x does not fit one read (65000 bytes)",
    },
  );
});

Deno.test("applyInstalled replaces the marks with a list, and clears them when they cannot be told", () => {
  const known = new Set(["git", "rtk"]);
  // A panel install's guess (rtk), then the read: the read wins.
  assertEquals(
    applyInstalled(known, { type: "pkg-installed", names: ["git", "jq"] }),
    undefined,
  );
  assertEquals([...known], ["git", "jq"]);
  // Cannot be told: no stale name stays Installed beside the note.
  assertEquals(
    applyInstalled(known, {
      type: "pkg-installed",
      error: "pkg's installed list is not there",
    }),
    "pkg's installed list is not there",
  );
  assertEquals(known.size, 0);
  // A fresh sandbox is unknown until it boots, not empty.
  known.add("git");
  assertEquals(applyInstalled(known, FRESH_SANDBOX), FRESH_SANDBOX.error);
  assertEquals(known.size, 0);
});
