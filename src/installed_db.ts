/**
 * What `pkg` has installed, read straight out of its database
 * (`/var/lib/yurt-pkg/installed.sqlite`): the page runs no guest process
 * to ask, so the read takes no lock and waits on no install.
 *
 * Just enough of the SQLite file format (https://sqlite.org/fileformat.html)
 * for one table: the schema on page 1 names the `packages` table's root
 * page; its b-tree's leaf cells are the rows. pkg opens the file in the
 * default rollback-journal mode, so the main file holds every committed
 * transaction; there is no WAL to merge. A transaction in flight leaves a
 * `-journal` beside it, and the caller does not read then.
 */

/** Where pkg keeps it, and the rollback journal a transaction in flight
 * leaves beside it. */
export const INSTALLED_DB_PATH = "/var/lib/yurt-pkg/installed.sqlite";
export const INSTALLED_DB_JOURNAL = `${INSTALLED_DB_PATH}-journal`;

/** The most of it read: pkg keeps every installed file's record in it,
 * 8.6 MB with the Python set; a cut file is refused, not misread. */
export const INSTALLED_DB_MAX_BYTES = 64 * 1024 * 1024;

/** pkg's schema version (`PRAGMA user_version`), whose `packages` table has
 * `name` first and `install_state` tenth (yurt-pkg crates/pkg/src/installed.rs). */
const SCHEMA_VERSION = 3;
const NAME = 0;
const INSTALL_STATE = 9;

/** A SQLite varint at `at`: its value and the offset after it. */
function varint(bytes: Uint8Array, at: number): [number, number] {
  let value = 0;
  for (let i = 0; i < 8; i++) {
    const byte = bytes[at + i];
    value = value * 128 + (byte & 0x7f);
    if (byte < 0x80) return [value, at + i + 1];
  }
  return [value * 256 + bytes[at + 8], at + 9];
}

/** The packages pkg recorded as installed, by name. A row an install has
 * prepared but not finished is not one. Throws on a file this does not
 * read. */
export function installedPackages(db: Uint8Array): string[] {
  const view = new DataView(db.buffer, db.byteOffset, db.byteLength);
  const text = new TextDecoder();
  if (text.decode(db.subarray(0, 16)) !== "SQLite format 3\0") {
    throw new Error("not a SQLite database");
  }
  const version = view.getUint32(60);
  if (version !== SCHEMA_VERSION) {
    throw new Error(`pkg's database has schema version ${version}`);
  }
  if (view.getUint32(56) !== 1) throw new Error("not a UTF-8 database");
  const size = view.getUint16(16) === 1 ? 65536 : view.getUint16(16);
  const usable = size - db[20];
  const start = (page: number) => {
    if (page < 1 || page * size > db.byteLength) {
      throw new Error(`page ${page} is past the end of the database`);
    }
    return (page - 1) * size;
  };
  /** A table cell's payload: its local part, then its overflow pages. */
  const payload = (at: number): Uint8Array => {
    const [length, afterLength] = varint(db, at);
    const [, body] = varint(db, afterLength);
    const max = usable - 35;
    const min = Math.floor((usable - 12) * 32 / 255) - 23;
    const spill = min + (length - min) % (usable - 4);
    const local = length <= max ? length : spill <= max ? spill : min;
    const out = new Uint8Array(length);
    out.set(db.subarray(body, body + local));
    let filled = local;
    let next = local < length ? view.getUint32(body + local) : 0;
    while (filled < length) {
      const page = start(next);
      const take = Math.min(usable - 4, length - filled);
      out.set(db.subarray(page + 4, page + 4 + take), filled);
      filled += take;
      next = view.getUint32(page);
    }
    return out;
  };
  /** A record's columns, as far as `last`: text, integers, or null. */
  const columns = (record: Uint8Array, last: number) => {
    const values: (string | number | null)[] = [];
    let [header, at] = varint(record, 0);
    let body = header;
    while (at < header && values.length <= last) {
      let type: number;
      [type, at] = varint(record, at);
      const width = type >= 12
        ? Math.floor((type - 12) / 2)
        : [0, 1, 2, 3, 4, 6, 8, 8, 0, 0][type];
      if (type >= 13 && type % 2 === 1) {
        values.push(text.decode(record.subarray(body, body + width)));
      } else if (type >= 1 && type <= 4) {
        let value = 0;
        for (let i = 0; i < width; i++) value = value * 256 + record[body + i];
        values.push(value);
      } else if (type === 8 || type === 9) {
        values.push(type - 8);
      } else {
        // Null, and what no column read here is: wider integers, floats,
        // blobs.
        values.push(null);
      }
      body += width;
    }
    return values;
  };
  /** Every row of the table b-tree rooted at `root`. */
  const rows = (root: number, last: number) => {
    const out: (string | number | null)[][] = [];
    const seen = new Set<number>();
    const walk = (page: number) => {
      if (seen.has(page)) throw new Error(`page ${page} is in a loop`);
      seen.add(page);
      const base = start(page);
      const header = page === 1 ? base + 100 : base;
      const kind = db[header];
      const cells = view.getUint16(header + 3);
      const pointers = header + (kind === 5 ? 12 : 8);
      for (let i = 0; i < cells; i++) {
        const cell = base + view.getUint16(pointers + 2 * i);
        if (kind === 13) out.push(columns(payload(cell), last));
        else if (kind === 5) walk(view.getUint32(cell));
        else throw new Error(`page ${page} is not a table page`);
      }
      if (kind === 5) walk(view.getUint32(header + 8));
    };
    walk(root);
    return out;
  };
  // sqlite_schema: type, name, tbl_name, rootpage, sql.
  const table = rows(1, 3).find(([type, name]) =>
    type === "table" && name === "packages"
  );
  if (table === undefined || typeof table[3] !== "number") {
    throw new Error("pkg's database has no packages table");
  }
  return rows(table[3], INSTALL_STATE)
    .filter((row) => row[INSTALL_STATE] === "installed")
    .map((row) => String(row[NAME]))
    .sort();
}

/** What pkg has installed, read with `readFile` (`undefined` for a file
 * that is not there). `undefined` while a pkg transaction is in flight
 * (its journal is there, before or after the read): the read after it
 * answers. None in a sandbox without pkg's database. */
export async function readInstalled(
  readFile: (
    path: string,
    maxBytes: number,
  ) => Promise<Uint8Array | undefined>,
): Promise<string[] | undefined> {
  const inFlight = async () =>
    await readFile(INSTALLED_DB_JOURNAL, 1) !== undefined;
  if (await inFlight()) return undefined;
  const db = await readFile(INSTALLED_DB_PATH, INSTALLED_DB_MAX_BYTES);
  if (await inFlight()) return undefined;
  return db === undefined ? [] : installedPackages(db);
}
