/**
 * What `pkg` has installed: its installed list (yurt-pkg docs/pkg.md,
 * "Installed package list"), read straight from the sandbox's VFS -- no
 * guest process, so no lock and no wait on an install. pkg replaces the
 * list by a rename after each commit, so a read sees a whole list.
 */

/** pkg's list, one `NAME<TAB>VERSION<TAB>BUILD` line per installed
 * package; and its database, which without the list means a pkg that does
 * not write one (or could not). */
export const INSTALLED_LIST_PATH = "/var/lib/yurt-pkg/installed.list";
export const INSTALLED_DB_PATH = "/var/lib/yurt-pkg/installed.sqlite";

/** Far more than every package in the repository needs. */
export const INSTALLED_LIST_MAX_BYTES = 1024 * 1024;

/** Up to `length` bytes of a sandbox file from `offset`, fewer at its end;
 * `undefined` when there is no such file. Any other failure throws. */
export type ReadAt = (
  path: string,
  offset: number,
  length: number,
) => Promise<Uint8Array | undefined>;

/** The package names in an installed list. A line that is not three
 * non-empty tab-separated fields is a broken list, and throws. */
export function installedNames(list: string): string[] {
  const lines = list.split("\n");
  // The newline that ends the last line.
  if (lines.at(-1) === "") lines.pop();
  return lines.map((line, i) => {
    const fields = line.split("\t");
    if (fields.length !== 3 || fields.some((field) => field === "")) {
      throw new Error(
        `pkg's installed list: line ${i + 1} is not NAME<TAB>VERSION<TAB>BUILD`,
      );
    }
    return fields[0];
  });
}

/** What pkg has installed in a sandbox whose files `readAt` reads.
 * `undefined` when that cannot be told: a database without a list. No
 * list and no database is no pkg state, nothing installed. */
export async function readInstalled(
  readAt: ReadAt,
): Promise<string[] | undefined> {
  // One byte more than is read: a list that fills it is longer.
  const list = await readAt(
    INSTALLED_LIST_PATH,
    0,
    INSTALLED_LIST_MAX_BYTES + 1,
  );
  if (list === undefined) {
    return await readAt(INSTALLED_DB_PATH, 0, 1) === undefined ? [] : undefined;
  }
  if (list.byteLength > INSTALLED_LIST_MAX_BYTES) {
    throw new Error(
      `pkg's installed list is longer than the ${INSTALLED_LIST_MAX_BYTES} bytes read`,
    );
  }
  return installedNames(new TextDecoder().decode(list));
}
