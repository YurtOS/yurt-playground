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

Deno.test("installedPackages reads no overflow page past the columns it needs", async () => {
  // rtk's files list grown past 40 overflow pages.
  const bytes = sqlite(
    (db) =>
      db.exec(
        "UPDATE packages SET files_json = printf('%.200000c', 'x') WHERE name = 'rtk'",
      ),
    REAL,
  );
  const reads: number[] = [];
  assertEquals(await installedPackages(at(bytes, reads)), REAL_NAMES);
  const read = reads.reduce((sum, length) => sum + length, 0);
  assert(read <= 8 * 4096, `${read} bytes read`);
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
  // Comments, and a state column added after its rows: they hold its
  // DEFAULT.
  const commented = sqlite((db) => {
    db.exec(`CREATE TABLE packages (
        -- the package, as pkg names it, (with a comma)
        name TEXT PRIMARY KEY, /* the state, follows, later */
        version TEXT
      );
      INSERT INTO packages (name) VALUES ('git'), ('jq');
      ALTER TABLE packages ADD COLUMN install_state TEXT DEFAULT 'installed';
      INSERT INTO packages (name, install_state) VALUES ('zsh', 'prepared');`);
  });
  assertEquals(await installedPackages(at(commented)), ["git", "jq"]);
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
    () => installedPackages(at(new Uint8Array(4096).fill(0x61))),
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

Deno.test("readInstalled: no database, or one too short for a header, is nothing installed", async () => {
  assertEquals(await readInstalled(files({})), []);
  // SQLite reads an empty file (or a cut header) as an empty database.
  for (const length of [0, 16, 99]) {
    assertEquals(
      await readInstalled(
        files({ [INSTALLED_DB_PATH]: REAL.slice(0, length) }),
      ),
      [],
      `${length} bytes`,
    );
  }
  assertEquals(
    await readInstalled(files({ [INSTALLED_DB_PATH]: REAL })),
    REAL_NAMES,
  );
});

Deno.test("readInstalled reports a database it cannot read, never nothing installed", async () => {
  // The kernel's VFS read failing (a directory where the file should be).
  const failing: ReadAt = (path) =>
    path === INSTALLED_DB_PATH
      ? Promise.reject(new Error(`read ${path}: rc=-21`))
      : Promise.resolve(undefined);
  await assertRejects(() => readInstalled(failing), Error, "rc=-21");
});

Deno.test("readInstalled reads again while a pkg run writes, and says when one keeps writing", async () => {
  const journal = new Uint8Array(512);
  const waits: number[] = [];
  const wait = (ms: number) => {
    waits.push(ms);
    return Promise.resolve();
  };
  // Busy for two reads, then done: the third read answers.
  let probes = 0;
  const have: Record<string, Uint8Array> = { [INSTALLED_DB_PATH]: REAL };
  const finishing: ReadAt = (path, offset, length) => {
    if (path === INSTALLED_DB_JOURNAL) {
      return Promise.resolve(probes++ < 2 ? journal : undefined);
    }
    return files(have)(path, offset, length);
  };
  assertEquals(await readInstalled(finishing, () => true, wait), REAL_NAMES);
  assertEquals(waits, [250, 500]);
  assertEquals(probes, 3, "one journal probe per read");
  // A run that keeps writing: about a minute of waits, then it says so --
  // not that a transaction died, which nothing here can tell.
  waits.length = 0;
  await assertRejects(
    () =>
      readInstalled(
        files({ [INSTALLED_DB_PATH]: REAL, [INSTALLED_DB_JOURNAL]: journal }),
        () => true,
        wait,
      ),
    Error,
    "pkg is still writing its database",
  );
  const waited = waits.reduce((sum, ms) => sum + ms, 0);
  assert(waited >= 60_000 && waited < 65_000, `${waited} ms`);
  assert(waits.every((ms) => ms <= 4000));
  // A run that committed while it was read (the change counter moved,
  // and its journal is gone): what was read may be torn; read again.
  waits.length = 0;
  const after = sqlite(
    (db) => db.exec("UPDATE packages SET version = 'x' WHERE name = 'zlib'"),
    REAL,
  );
  let counterReads = 0;
  const committing: ReadAt = (path, offset, length) => {
    if (path === INSTALLED_DB_JOURNAL) return Promise.resolve(undefined);
    // The first read sees the old file; from its counter check on, the new.
    if (offset === 24 && length === 4) counterReads++;
    return at(counterReads === 0 ? REAL : after)(offset, length);
  };
  assertEquals(await readInstalled(committing, () => true, wait), REAL_NAMES);
  assertEquals(waits, [250]);
});

Deno.test("readInstalled reads the header once per read", async () => {
  const reads: [number, number][] = [];
  await readInstalled((path, offset, length) => {
    if (path === INSTALLED_DB_PATH) reads.push([offset, length]);
    return files({ [INSTALLED_DB_PATH]: REAL })(path, offset, length);
  });
  assertEquals(reads.filter(([offset]) => offset === 0), [[0, 100]]);
});

Deno.test("readInstalled stops, answering nothing, once its sandbox is dropped", async () => {
  const journal = new Uint8Array(512);
  // Dropped while it waits out a pkg run: no more reads of the old one.
  let live = true;
  let reads = 0;
  const busy: ReadAt = (path, offset, length) => {
    reads++;
    return files({
      [INSTALLED_DB_PATH]: REAL,
      [INSTALLED_DB_JOURNAL]: journal,
    })(
      path,
      offset,
      length,
    );
  };
  const waiting = readInstalled(busy, () => live, () => {
    live = false;
    return Promise.resolve();
  });
  assertEquals(await waiting, undefined);
  const afterDrop = reads;
  await Promise.resolve();
  assertEquals(reads, afterDrop);
  // Dropped mid-read: what it read is not answered, nor is an error.
  let left = 3;
  assertEquals(
    await readInstalled(
      (path, offset, length) => {
        if (--left === 0) live = false;
        return files({ [INSTALLED_DB_PATH]: REAL })(path, offset, length);
      },
      () => left > 0,
    ),
    undefined,
  );
});
