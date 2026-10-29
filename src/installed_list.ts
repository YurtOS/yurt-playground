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
};

/** What the coordinator tells the Packages panel: every package installed,
 * or why that cannot be told, and whether the panel's marks go with it. */
export type InstalledReport =
  | { type: "pkg-installed"; names: string[] }
  | { type: "pkg-installed"; error: string; clear: boolean };

/** While a fresh sandbox boots, what it has installed is unknown. */
export const FRESH_SANDBOX = {
  type: "pkg-installed",
  error: "a fresh sandbox is starting",
  clear: true,
} as const satisfies InstalledReport;

/** A fresh sandbox that did not boot: nothing of it is known. */
export function freshSandboxFailed(why: string): InstalledReport {
  return {
    type: "pkg-installed",
    error: `a fresh sandbox did not start: ${why}`,
    clear: true,
  };
}

/** The package names in an installed list. A line that is not three
 * tab-separated fields, or has no name, or a list that is not UTF-8, is a
 * broken list, and throws. */
export function installedNames(bytes: Uint8Array): string[] {
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
    return fields[0];
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
    // A pkg that does not write the list (or could not): the panel keeps
    // what its own installs marked.
    if (await files.exists(INSTALLED_DB_PATH)) {
      return {
        type: "pkg-installed",
        error: "pkg's installed list is not there",
        clear: false,
      };
    }
    return { type: "pkg-installed", names: [] };
  } catch (error) {
    return {
      type: "pkg-installed",
      error: error instanceof Error ? error.message : String(error),
      clear: true,
    };
  }
}

/** The panel's marks after `report`: replaced by its names (a panel
 * install's guess with them); when they cannot be told, cleared if the
 * report says so, so no stale name stays Installed beside the note. The
 * note, if any. */
export function applyInstalled(
  known: Set<string>,
  report: InstalledReport,
): string | undefined {
  if ("error" in report) {
    if (report.clear) known.clear();
    return `cannot tell which packages are installed: ${report.error}`;
  }
  known.clear();
  for (const name of report.names) known.add(name);
  return undefined;
}
