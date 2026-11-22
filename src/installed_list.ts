/**
 * What `pkg` has installed: its installed list (yurt-pkg docs/pkg.md,
 * "Installed package list"), read straight from the sandbox's VFS -- no
 * guest process, so no lock and no wait on an install. pkg replaces the
 * list by a rename after each commit, and it is read in one VFS read, so
 * what is read is one whole list.
 */

/** pkg's list, one `NAME<TAB>VERSION<TAB>BUILD` line per installed
 * package; and its database, which without the list leaves what is
 * installed unknown. */
export const INSTALLED_LIST_PATH = "/var/lib/yurt-pkg/installed.list";
export const INSTALLED_DB_PATH = "/var/lib/yurt-pkg/installed.sqlite";

/** A sandbox's files, as the coordinator reads them. */
export type SandboxFiles = {
  /** The whole file in one read; `undefined` when there is none. Rejects
   * on any other failure, or a file too big for one read. */
  readWhole(path: string): Promise<Uint8Array | undefined>;
  exists(path: string): Promise<boolean>;
  /** A regular file there, not a symlink; rejects as `readWhole` does. */
  isFile(path: string): Promise<boolean>;
};

/** What the coordinator tells the Packages panel: every package installed;
 * that pkg keeps no list (expected before yurt-pkg#59); or why it cannot
 * be told -- `reset` when that is because the sandbox was replaced. */
export type InstalledReport =
  | { type: "pkg-installed"; names: string[] }
  | { type: "pkg-installed"; unlisted: true }
  | { type: "pkg-installed"; error: string; reset?: true };

/** While a fresh sandbox boots, what it has installed is unknown. */
export const FRESH_SANDBOX = {
  type: "pkg-installed",
  error: "a fresh sandbox is starting",
  reset: true,
} as const satisfies InstalledReport;

/** A fresh sandbox that did not boot: nothing of it is known. */
export function freshSandboxFailed(why: string): InstalledReport {
  return {
    type: "pkg-installed",
    error: `a fresh sandbox did not start: ${why}`,
  };
}

/** One installed release, as pkg's list names it. */
export type InstalledRelease = { name: string; version: string; build: string };

/** The package names in an installed list. A line that is not three
 * tab-separated fields, or has no name, or a list that is not UTF-8, is a
 * broken list, and throws. */
export function installedNames(bytes: Uint8Array): string[] {
  return parseInstalledList(bytes).map((release) => release.name);
}

/** What pkg has installed in a sandbox, release by release: pkg never
 * replaces an installed package, so a set installed beside one must hold
 * that exact release (src/packages.ts `resolveSet`). `[]` when there is no
 * list (nothing installed), `undefined` when the page has no `files` of
 * its own (the desktop app's session); a list that cannot be read, or is
 * broken, rejects. */
export async function installedReleases(
  files: SandboxFiles | undefined,
): Promise<InstalledRelease[] | undefined> {
  if (files === undefined) return undefined;
  const list = await files.readWhole(INSTALLED_LIST_PATH);
  return list === undefined ? [] : parseInstalledList(list);
}

/** pkg's installed list, release by release; throws on a broken one. */
export function parseInstalledList(bytes: Uint8Array): InstalledRelease[] {
  let list: string;
  try {
    list = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("pkg's installed list is broken: not UTF-8");
  }
  const lines = list.split("\n");
  // The newline that ends the last line.
  if (lines.at(-1) === "") lines.pop();
  return lines.map((line, i) => {
    const fields = line.split("\t");
    if (fields.length !== 3 || fields[0] === "") {
      throw new Error(
        `pkg's installed list: line ${i + 1} is not NAME<TAB>VERSION<TAB>BUILD`,
      );
    }
    return { name: fields[0], version: fields[1], build: fields[2] };
  });
}

/** What pkg has installed in a sandbox, for the panel. No list and no
 * database is no pkg state: nothing installed. A database without a list
 * is unknown, never nothing installed. */
export async function installedReport(
  files: SandboxFiles,
): Promise<InstalledReport> {
  try {
    const list = await files.readWhole(INSTALLED_LIST_PATH);
    if (list !== undefined) {
      return { type: "pkg-installed", names: installedNames(list) };
    }
    // A pkg that does not write the list (or could not).
    if (await files.exists(INSTALLED_DB_PATH)) {
      return { type: "pkg-installed", unlisted: true };
    }
    return { type: "pkg-installed", names: [] };
  } catch (error) {
    return {
      type: "pkg-installed",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** The coordinator's side: what it posts at each point of a sandbox's
 * life. `files` is the in-tab sandbox's, if there is one. */
export function installedReporter(
  post: (report: InstalledReport) => void,
  files: () => SandboxFiles | undefined,
) {
  return {
    /** At boot, after every install, and when the panel opens. */
    async read() {
      const current = files();
      if (current !== undefined) post(await installedReport(current));
    },
    /** The sandbox was dropped for a fresh one. */
    dropped: () => post(FRESH_SANDBOX),
    /** The fresh one did not boot. */
    freshFailed: (why: string) => post(freshSandboxFailed(why)),
  };
}

/** The panel's side: the names it marks Installed, given to `render` on
 * every change, and the note beside them, given to `showNote` only when it
 * changes ("" for none); `ask` asks the coordinator to read. */
export function installedMarks(
  ask: () => void,
  render: (known: ReadonlySet<string>) => void,
  showNote: (note: string) => void,
) {
  const known = new Set<string>();
  let note = "";
  /** Bumped when the sandbox is replaced: an install begun before belongs
   * to the old one. */
  let sandbox = 0;
  const setNote = (text: string) => {
    if (text !== note) showNote(note = text);
  };
  return {
    /** Every open: the terminal or an agent may have installed since. */
    opened: () => ask(),
    report(report: InstalledReport) {
      if ("names" in report) {
        known.clear();
        for (const name of report.names) known.add(name);
        setNote("");
      } else if ("error" in report) {
        // No stale name stays Installed beside the note.
        known.clear();
        setNote(`cannot tell which packages are installed: ${report.error}`);
        if (report.reset) sandbox++;
      } else {
        // pkg keeps no list: the panel's own marks stay, without a note.
        setNote("");
      }
      render(known);
    },
    /** When an install begins: what `installed` is given back. */
    installStarted: () => sandbox,
    /** An install's plan, marked at once until the read after it says;
     * not if the sandbox was replaced since it began. */
    installed(started: number, names: readonly string[]) {
      if (started === sandbox) { for (const name of names) known.add(name); }
      render(known);
    },
    /** The current marks, for rows just made. */
    render: () => render(known),
  };
}
