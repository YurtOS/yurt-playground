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
  /** The whole file in one read; `undefined` when there is none. Throws
   * on any other failure, or a file too big for one read. */
  readWhole(path: string): Promise<Uint8Array | undefined>;
  exists(path: string): Promise<boolean>;
};

/** What the coordinator tells the Packages panel: every package installed,
 * or why that cannot be told. */
export type InstalledReport =
  | { type: "pkg-installed"; names: string[] }
  | { type: "pkg-installed"; error: string };

/** While a fresh sandbox boots, what it has installed is unknown. */
export const FRESH_SANDBOX = {
  type: "pkg-installed",
  error: "a fresh sandbox is starting",
} as const satisfies InstalledReport;

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
    if (await files.exists(INSTALLED_DB_PATH)) {
      return {
        type: "pkg-installed",
        error: "pkg's installed list is not there",
      };
    }
    return { type: "pkg-installed", names: [] };
  } catch (error) {
    return {
      type: "pkg-installed",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** The panel's marks after `report`: replaced by its names (a panel
 * install's guess with them), or cleared when they cannot be told, so no
 * stale name stays Installed beside the note. The note, if any. */
export function applyInstalled(
  known: Set<string>,
  report: InstalledReport,
): string | undefined {
  known.clear();
  if ("error" in report) return report.error;
  for (const name of report.names) known.add(name);
  return undefined;
}
