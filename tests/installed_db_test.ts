import { assert, assertEquals, assertRejects } from "@std/assert";
import { DatabaseSync } from "node:sqlite";
import {
  INSTALLED_DB_JOURNAL,
  INSTALLED_DB_PATH,
  installedPackages,
  type ReadAt,
  readInstalled,
} from "../src/installed_db.ts";

/** A real `installed.sqlite`: the native `pkg` (yurt-pkg) installed make,
 * pkgconf, rtk, zlib and zstd (and three more, deleted again with sqlite3
 * to keep the file small). */
const REAL = Deno.readFileSync(
  new URL("./fixtures/pkg-installed.sqlite", import.meta.url),
);
const REAL_NAMES = ["make", "pkgconf", "rtk", "zlib", "zstd"];

/** A database's bytes after `change` (SQLite itself writing them), on a
 * copy of `from`, or on a new database. */
function sqlite(
  change: (db: DatabaseSync) => void,
  from?: Uint8Array,
): Uint8Array {
  const path = Deno.makeTempFileSync({ suffix: ".sqlite" });
  try {
    Deno.writeFileSync(path, from ?? new Uint8Array());
    const db = new DatabaseSync(path);
    change(db);
    db.close();
    return Deno.readFileSync(path);
  } finally {
    Deno.removeSync(path);
  }
}

/** Reads of `bytes` at an offset, as the VFS answers them: fewer at the
 * end; each read's length is recorded. */
function at(bytes: Uint8Array, reads: number[] = []) {
  return (offset: number, length: number) => {
    reads.push(length);
    return Promise.resolve(bytes.slice(offset, offset + length));
  };
}

/** A sandbox's files, read at an offset; `undefined` for a missing one. */
function files(have: Record<string, Uint8Array>): ReadAt {
  return (path, offset, length) =>
    have[path] === undefined
      ? Promise.resolve(undefined)
      : at(have[path])(offset, length);
}

Deno.test("installedPackages reads the names pkg recorded as installed", async () => {
  assertEquals(await installedPackages(at(REAL)), REAL_NAMES);
});

Deno.test("installedPackages reads only page 1 and the packages table's pages", async () => {
  const reads: number[] = [];
  await installedPackages(at(REAL, reads));
  const read = reads.reduce((sum, length) => sum + length, 0);
  // The files table, most of the file, is never read.
  assert(read * 4 < REAL.byteLength, `${read} of ${REAL.byteLength} bytes`);
});

Deno.test("installedPackages walks interior pages and overflow chains, and skips a half-done install", async () => {
  let expected: string[] = [];
  const bytes = sqlite((db) => {
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
  }, REAL);
  assertEquals(expected.length, 405);
  assertEquals(await installedPackages(at(bytes)), expected);
});

Deno.test("installedPackages finds the columns by the table's own definition", async () => {
  // Another schema version, its columns in another order, one added later.
  const bytes = sqlite((db) => {
    db.exec(`PRAGMA user_version = 7;
      CREATE TABLE packages (
        "install_state" TEXT NOT NULL CHECK (install_state IN ('prepared', 'installed')),
        files_json TEXT NOT NULL DEFAULT '[]',
        [name] TEXT PRIMARY KEY,
        UNIQUE (files_json, name)
      );
      ALTER TABLE packages ADD COLUMN note TEXT DEFAULT 'a, b';
      INSERT INTO packages (install_state, name) VALUES
        ('installed', 'git'), ('prepared', 'jq'), ('installed', 'ca-certificates');`);
  });
  assertEquals(await installedPackages(at(bytes)), ["ca-certificates", "git"]);
  const unnamed = sqlite((db) =>
    db.exec("CREATE TABLE packages (name TEXT PRIMARY KEY, state TEXT)")
  );
  await assertRejects(
    () => installedPackages(at(unnamed)),
    Error,
    "no install_state column",
  );
});

Deno.test("installedPackages refuses what is not pkg's database", async () => {
  await assertRejects(
    () => installedPackages(at(new TextEncoder().encode("not a database"))),
    Error,
    "not a SQLite database",
  );
  // Cut short: a page it needs is not all there.
  await assertRejects(
    () => installedPackages(at(REAL.subarray(0, 4096))),
    Error,
    "ends before",
  );
});

Deno.test("readInstalled: no database is nothing installed", async () => {
  assertEquals(await readInstalled(files({})), []);
  assertEquals(
    await readInstalled(files({ [INSTALLED_DB_PATH]: REAL })),
    REAL_NAMES,
  );
});

Deno.test("readInstalled reports a database it cannot read, never nothing installed", async () => {
  // Unreadable (EACCES, EIO): the error, not an empty list.
  const denied: ReadAt = (path) =>
    path === INSTALLED_DB_PATH
      ? Promise.reject(new Error(`read ${path}: rc=-13`))
      : Promise.resolve(undefined);
  await assertRejects(() => readInstalled(denied), Error, "rc=-13");
  // Gone halfway through the read.
  let reads = 0;
  const vanishing: ReadAt = (path, offset, length) =>
    path === INSTALLED_DB_PATH && reads++ < 2
      ? at(REAL)(offset, length)
      : Promise.resolve(undefined);
  await assertRejects(() => readInstalled(vanishing), Error, "went away");
});

Deno.test("readInstalled waits out a pkg run, and reports a journal it leaves behind", async () => {
  const journal = new Uint8Array(512);
  // A pkg run that finishes: the next try reads it.
  const have: Record<string, Uint8Array> = {
    [INSTALLED_DB_PATH]: REAL,
    [INSTALLED_DB_JOURNAL]: journal,
  };
  const finishing: ReadAt = (path, offset, length) => {
    const answer = files(have)(path, offset, length);
    if (path === INSTALLED_DB_JOURNAL) delete have[INSTALLED_DB_JOURNAL];
    return answer;
  };
  assertEquals(await readInstalled(finishing, 0), REAL_NAMES);
  // One that died mid-transaction: its journal stays.
  await assertRejects(
    () =>
      readInstalled(
        files({
          [INSTALLED_DB_PATH]: REAL,
          [INSTALLED_DB_JOURNAL]: journal,
        }),
        0,
      ),
    Error,
    "pkg's database has an unfinished transaction; the next pkg run repairs it",
  );
  // A run that begins while it is read, and is still running: what was
  // read may be torn, and is not answered.
  let journalReads = 0;
  const beginning: ReadAt = (path, offset, length) =>
    path === INSTALLED_DB_JOURNAL
      ? Promise.resolve(journalReads++ === 0 ? undefined : journal)
      : at(REAL)(offset, length);
  await assertRejects(
    () => readInstalled(beginning, 0),
    Error,
    "unfinished transaction",
  );
});
