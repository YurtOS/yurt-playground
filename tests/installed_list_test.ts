import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  INSTALLED_DB_PATH,
  INSTALLED_LIST_MAX_BYTES,
  INSTALLED_LIST_PATH,
  installedNames,
  readInstalled,
} from "../src/installed_list.ts";
import type { ReadAt } from "../src/installed_list.ts";

const LIST = "ca-certificates\t2026.9.25\tyurt_0\n" +
  "git\t2.55.0\tyurt_0\n" +
  "python\t3.14.7\tyurt_0\n";

/** A sandbox's files, read at an offset as the kernel's VFS read answers:
 * fewer bytes at the end, `undefined` for a missing file. */
function files(have: Record<string, string | Uint8Array>): ReadAt {
  return (path, offset, length) => {
    const file = have[path];
    if (file === undefined) return Promise.resolve(undefined);
    const bytes = typeof file === "string"
      ? new TextEncoder().encode(file)
      : file;
    return Promise.resolve(bytes.slice(offset, offset + length));
  };
}

Deno.test("installedNames is the first field of each NAME<TAB>VERSION<TAB>BUILD line", () => {
  assertEquals(installedNames(LIST), ["ca-certificates", "git", "python"]);
  // An empty list: nothing installed.
  assertEquals(installedNames(""), []);
  // A last line without its newline is still a line.
  assertEquals(installedNames("rtk\t0.50.0\t1"), ["rtk"]);
  // A name an older pkg let through is still a name.
  assertEquals(installedNames("Old_Name\t1\tlocal\n"), ["Old_Name"]);
});

Deno.test("installedNames refuses a line that is not three fields", () => {
  // pkg writes every line whole (its list is replaced by a rename), so a
  // bad line is a broken list, refused rather than half read.
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
      () => installedNames(bad),
      Error,
      "is not NAME<TAB>VERSION<TAB>BUILD",
      JSON.stringify(bad),
    );
  }
  assertThrows(
    () => installedNames(LIST + "broken\n"),
    Error,
    "line 4",
  );
});

Deno.test("readInstalled reads pkg's installed list", async () => {
  assertEquals(
    await readInstalled(files({ [INSTALLED_LIST_PATH]: LIST })),
    ["ca-certificates", "git", "python"],
  );
  assertEquals(
    await readInstalled(
      files({ [INSTALLED_LIST_PATH]: "", [INSTALLED_DB_PATH]: "db" }),
    ),
    [],
  );
});

Deno.test("readInstalled: no list and no database is no pkg state, nothing installed", async () => {
  assertEquals(await readInstalled(files({})), []);
});

Deno.test("readInstalled: a database without a list is unknown, never nothing installed", async () => {
  // An image whose pkg does not write the list, or a pkg that could not
  // update it.
  assertEquals(
    await readInstalled(files({ [INSTALLED_DB_PATH]: "db" })),
    undefined,
  );
});

Deno.test("readInstalled refuses a list too long to have been read whole, and a failed read", async () => {
  await assertRejects(
    () =>
      readInstalled(
        files({
          [INSTALLED_LIST_PATH]: new Uint8Array(INSTALLED_LIST_MAX_BYTES + 1)
            .fill(0x61),
        }),
      ),
    Error,
    "longer than",
  );
  await assertRejects(
    () =>
      readInstalled((path) =>
        Promise.reject(new Error(`read ${path}: rc=-21`))
      ),
    Error,
    "rc=-21",
  );
});
