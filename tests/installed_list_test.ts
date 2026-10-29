import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  FRESH_SANDBOX,
  freshSandboxFailed,
  INSTALLED_DB_PATH,
  INSTALLED_LIST_PATH,
  installedMarks,
  installedNames,
  installedReport,
  installedReporter,
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
  // A database without a list: a pkg that keeps none (the images before
  // yurt-pkg#59), or one whose write of it failed. Unknown, never nothing
  // installed; and expected, so quiet.
  assertEquals(
    await installedReport(files({ [INSTALLED_DB_PATH]: "db" })),
    { type: "pkg-installed", unlisted: true },
  );
  // A broken list, and a read that fails.
  assertEquals(
    await installedReport(files({ [INSTALLED_LIST_PATH]: "broken\n" })),
    {
      type: "pkg-installed",
      error: "pkg's installed list: line 1 is not NAME<TAB>VERSION<TAB>BUILD",
    },
  );
  assertEquals(
    await installedReport({
      readWhole: () => Promise.reject(new Error("read /x: is a directory")),
      exists: () => Promise.resolve(true),
    }),
    { type: "pkg-installed", error: "read /x: is a directory" },
  );
});

/** The Packages panel's marks, driven as the page drives them; each
 * render recorded as [names marked, the note]. */
function panel() {
  const renders: [string[], string | undefined][] = [];
  let asks = 0;
  const marks = installedMarks(
    () => asks++,
    (known, note) => renders.push([[...known].sort(), note]),
  );
  return { marks, renders, asks: () => asks };
}

Deno.test("the panel asks for a read every time it opens", () => {
  const { marks, asks } = panel();
  marks.opened();
  marks.opened();
  assertEquals(asks(), 2);
});

Deno.test("the panel marks what a list names, and an install's guess until the list says", () => {
  const { marks, renders } = panel();
  marks.report({ type: "pkg-installed", names: ["git"] });
  assertEquals(renders.at(-1), [["git"], undefined]);
  // An install: its plan's names at once...
  marks.installed(marks.installStarted(), ["jq", "libonig"]);
  assertEquals(renders.at(-1), [["git", "jq", "libonig"], undefined]);
  // ...until the read after it, which wins.
  marks.report({ type: "pkg-installed", names: ["git", "jq"] });
  assertEquals(renders.at(-1), [["git", "jq"], undefined]);
});

Deno.test("the panel keeps its own marks, quietly, when pkg keeps no list", () => {
  const { marks, renders } = panel();
  marks.installed(marks.installStarted(), ["rtk"]);
  marks.report({ type: "pkg-installed", unlisted: true });
  // No note: on an image before yurt-pkg#59 this is every read.
  assertEquals(renders.at(-1), [["rtk"], undefined]);
});

Deno.test("the panel clears its marks and says why when they cannot be told", () => {
  const note = (why: string) =>
    `cannot tell which packages are installed: ${why}`;
  const { marks, renders } = panel();
  marks.report({ type: "pkg-installed", names: ["git"] });
  marks.report({ type: "pkg-installed", error: "broken" });
  assertEquals(renders.at(-1), [[], note("broken")]);
  // The next read that works hides the note.
  marks.report({ type: "pkg-installed", names: ["git"] });
  assertEquals(renders.at(-1), [["git"], undefined]);
  // A fresh sandbox, and one that did not boot.
  marks.report(FRESH_SANDBOX);
  assertEquals(renders.at(-1), [[], note("a fresh sandbox is starting")]);
  marks.report(freshSandboxFailed("not crossOriginIsolated"));
  assertEquals(renders.at(-1), [
    [],
    note("a fresh sandbox did not start: not crossOriginIsolated"),
  ]);
});

Deno.test("an install in a dropped sandbox marks nothing in the fresh one", () => {
  const { marks, renders } = panel();
  const started = marks.installStarted();
  marks.report(FRESH_SANDBOX);
  marks.installed(started, ["rtk"]);
  assertEquals(renders.at(-1)?.[0], []);
  // One started in the fresh sandbox does.
  marks.installed(marks.installStarted(), ["jq"]);
  assertEquals(renders.at(-1)?.[0], ["jq"]);
});

Deno.test("the coordinator reports reads of the in-tab sandbox, a dropped sandbox, and a failed fresh boot", async () => {
  const posted: unknown[] = [];
  let current: SandboxFiles | undefined = files({
    [INSTALLED_LIST_PATH]: LIST,
  });
  const reporter = installedReporter(
    (report) => posted.push(report),
    () => current,
  );
  await reporter.read();
  assertEquals(posted.at(-1), {
    type: "pkg-installed",
    names: ["ca-certificates", "git", "python"],
  });
  reporter.dropped();
  assertEquals(posted.at(-1), FRESH_SANDBOX);
  reporter.freshFailed("boom");
  assertEquals(posted.at(-1), freshSandboxFailed("boom"));
  // No in-tab sandbox (the desktop app's, or none yet): nothing to read.
  current = undefined;
  const before = posted.length;
  await reporter.read();
  assertEquals(posted.length, before);
});

Deno.test("the coordinator reports at boot, after every install, on a panel open, and on a fresh sandbox", () => {
  // Which lifecycle points call the reporter: read from the worker's
  // source, scoped to each point's own code (the worker cannot run here).
  const worker = Deno.readTextFileSync(
    new URL("../src/coordinator_worker.ts", import.meta.url),
  );
  const body = (from: string, to: string) => {
    const start = worker.indexOf(from);
    assert(start >= 0, from);
    return worker.slice(start, worker.indexOf(to, start));
  };
  assert(
    /packageSession = session;\s*void installed\.read\(\);/.test(
      body("booted: (session) =>", "},"),
    ),
  );
  assert(
    // The function's last statement: after every install, failed or not.
    /finally \{\s*await installed\.read\(\);\s*\}$/.test(
      body("async function servePackages", "\n}\n"),
    ),
  );
  assert(
    /finally \{[^}]*await installed\.read\(\);\s*\}\s*\};\s*$/.test(
      body("installPython = python === undefined", "  /** Boot, install"),
    ),
  );
  assert(
    /if \(msg\.type === "pkg-read-installed"\) await installed\.read\(\);/
      .test(worker),
  );
  assert(
    /^\s*installed\.dropped\(\);/m.test(body("const dropSandbox", "\n  };\n")),
  );
  assert(
    /installed\.freshFailed\(bootError \?\? "unknown"\);/.test(
      body(
        "if (packageSession === undefined) {\n        pythonMissing",
        "\n      }\n",
      ),
    ),
  );
});

Deno.test("the page reports, asks on open, guesses per install, and renders new rows", () => {
  // Where the page calls the panel's marks: read from its source, scoped
  // to each point's own code (the page needs a DOM to run).
  const page = Deno.readTextFileSync(
    new URL("../src/page.ts", import.meta.url),
  );
  const body = (from: string, to: string) => {
    const start = page.indexOf(from);
    assert(start >= 0, from);
    return page.slice(start, page.indexOf(to, start));
  };
  // Every report the coordinator posts reaches the marks.
  assert(
    /^if \(msg\.type === "pkg-installed"\) \{\s*installedPanel\.report\(msg\);\s*$/
      .test(body('if (msg.type === "pkg-installed")', "\n    }\n")),
  );
  // Every open of the panel asks for a read, before anything else.
  assert(
    /^const show = async \(\) => \{\s*installedPanel\.opened\(\);/.test(
      body("const show = async", "\n  };\n"),
    ),
  );
  // An install's sandbox is taken before it is awaited, and its guess is
  // given back with it after.
  const install = body("const install = async", "\n  };\n");
  const started = install.indexOf(
    "const started = installedPanel.installStarted();",
  );
  const awaited = install.indexOf("await packageInstall(");
  const guessed = install.indexOf("installedPanel.installed(started,");
  assert(started >= 0 && awaited > started && guessed > awaited, install);
  // The rows, once built, show the current marks.
  assert(
    /list\.append\(tr\);\s*\}\s*installedPanel\.render\(\);\s*$/.test(
      body("for (const row of catalogRows(catalog))", "\n  };\n"),
    ),
  );
});
