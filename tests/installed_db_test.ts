import { assertEquals, assertThrows } from "@std/assert";
import { DatabaseSync } from "node:sqlite";
import {
  INSTALLED_DB_JOURNAL,
  INSTALLED_DB_PATH,
  installedPackages,
  readInstalled,
} from "../src/installed_db.ts";

/** A real `installed.sqlite`: the native `pkg` (yurt-pkg) installed make,
 * pkgconf, rtk, zlib and zstd (and three more, deleted again with sqlite3
 * to keep the file small). */
const REAL = Deno.readFileSync(
  new URL("./fixtures/pkg-installed.sqlite", import.meta.url),
);

/** The fixture, changed by SQLite itself; its bytes after `change`. */
function changed(change: (db: DatabaseSync) => void): Uint8Array {
  const path = Deno.makeTempFileSync({ suffix: ".sqlite" });
  try {
    Deno.writeFileSync(path, REAL);
    const db = new DatabaseSync(path);
    change(db);
    db.close();
    return Deno.readFileSync(path);
  } finally {
    Deno.removeSync(path);
  }
}

Deno.test("installedPackages reads the names pkg recorded as installed", () => {
  assertEquals(installedPackages(REAL), [
    "make",
    "pkgconf",
    "rtk",
    "zlib",
    "zstd",
  ]);
});

Deno.test("installedPackages walks interior pages and overflow chains, and skips a half-done install", () => {
  let expected: string[] = [];
  const bytes = changed((db) => {
    const insert = db.prepare(
      `INSERT INTO packages SELECT ?, version, build, repo_id, ?,
         sha256, size, installed_at, install_transaction_id, ?, index_json,
         ?, yurt_json FROM packages WHERE name = 'rtk'`,
    );
    // Enough rows for interior table pages; some far bigger than a page,
    // so their records go on in overflow pages -- with a long URL, even the
    // install state the reader needs is there.
    for (let i = 0; i < 400; i++) {
      insert.run(
        `pkg-${String(i).padStart(3, "0")}`,
        `https://example.test/${"u".repeat(i % 50 === 0 ? 5_000 : 1)}`,
        "installed",
        "x".repeat(i % 50 === 0 ? 20_000 : 10),
      );
    }
    insert.run("half-done", "https://example.test/", "prepared", "[]");
    expected = db.prepare(
      "SELECT name FROM packages WHERE install_state = 'installed' ORDER BY name",
    ).all().map((row) => String(row.name));
  });
  assertEquals(expected.length, 405);
  assertEquals(installedPackages(bytes), expected);
});

Deno.test("installedPackages refuses what is not pkg's database", () => {
  assertThrows(
    () => installedPackages(new TextEncoder().encode("not a database")),
    Error,
    "not a SQLite database",
  );
  // Another schema version: its columns may not be where this reads them.
  assertThrows(
    () =>
      installedPackages(changed((db) => db.exec("PRAGMA user_version = 4"))),
    Error,
    "schema version 4",
  );
  // Cut short: a page it points at is not there.
  assertThrows(
    () => installedPackages(REAL.subarray(0, 4096)),
    Error,
    "past the end",
  );
});

Deno.test("readInstalled reads pkg's database, and not while a transaction is in flight", async () => {
  /** A sandbox's files; `during` runs as the database is read. */
  const files =
    (have: Record<string, Uint8Array>, during = () => {}) => (path: string) => {
      if (path === INSTALLED_DB_PATH) during();
      return Promise.resolve(have[path]);
    };
  assertEquals(
    await readInstalled(files({ [INSTALLED_DB_PATH]: REAL })),
    ["make", "pkgconf", "rtk", "zlib", "zstd"],
  );
  // An image without pkg's database has nothing installed by pkg.
  assertEquals(await readInstalled(files({})), []);
  // A pkg run is writing it: no answer now.
  const journal = new Uint8Array(512);
  assertEquals(
    await readInstalled(
      files({ [INSTALLED_DB_PATH]: REAL, [INSTALLED_DB_JOURNAL]: journal }),
    ),
    undefined,
  );
  // One began while it was read: what was read may be torn.
  const have: Record<string, Uint8Array> = { [INSTALLED_DB_PATH]: REAL };
  assertEquals(
    await readInstalled(
      files(have, () => have[INSTALLED_DB_JOURNAL] = journal),
    ),
    undefined,
  );
});
