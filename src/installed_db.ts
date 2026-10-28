/**
 * What `pkg` has installed, read straight out of its database
 * (`/var/lib/yurt-pkg/installed.sqlite`): the page runs no guest process
 * to ask, so the read takes no lock and waits on no install.
 *
 * Just enough of the SQLite file format (https://sqlite.org/fileformat.html)
 * for one table: the schema on page 1 names the `packages` table's root
 * page and its columns; its b-tree's leaf cells are the rows. Only those
 * pages are read, each at its offset. pkg opens the file in the default
 * rollback-journal mode, so the main file holds every committed
 * transaction; there is no WAL to merge. A transaction in flight leaves a
 * `-journal` beside it.
 */

/** Where pkg keeps it, and the rollback journal a transaction in flight
 * leaves beside it. */
export const INSTALLED_DB_PATH = "/var/lib/yurt-pkg/installed.sqlite";
export const INSTALLED_DB_JOURNAL = `${INSTALLED_DB_PATH}-journal`;

/** Up to `length` bytes of a sandbox file from `offset`, fewer at its end;
 * `undefined` when there is no such file. Any other failure throws. */
export type ReadAt = (
  path: string,
  offset: number,
  length: number,
) => Promise<Uint8Array | undefined>;

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

/** A table's column names, in order, from its `CREATE TABLE` text: the
 * first word of each top-level definition. Table constraints come after
 * every column, so they move no column's position. */
function columnNames(sql: string): string[] {
  const body = sql.slice(sql.indexOf("(") + 1, sql.lastIndexOf(")"));
  const definitions: string[] = [];
  let depth = 0;
  let quote = "";
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (quote !== "") {
      if (c === quote) quote = "";
    } else if (c === "'" || c === '"' || c === "`") quote = c;
    else if (c === "[") quote = "]";
    else if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "," && depth === 0) {
      definitions.push(body.slice(start, i));
      start = i + 1;
    }
  }
  definitions.push(body.slice(start));
  return definitions.map((definition) => {
    const word = definition.trim().match(
      /^(?:"([^"]*)"|`([^`]*)`|\[([^\]]*)\]|([^\s(]+))/,
    );
    return (word?.slice(1).find((part) => part !== undefined) ?? "")
      .toLowerCase();
  });
}

/** The packages pkg recorded as installed, by name, reading the database
 * with `read` (fewer bytes at its end). A row an install has prepared but
 * not finished is not one. Throws on a file this does not read. */
export async function installedPackages(
  read: (offset: number, length: number) => Promise<Uint8Array>,
): Promise<string[]> {
  const text = new TextDecoder();
  const exactly = async (offset: number, length: number) => {
    const bytes = await read(offset, length);
    if (bytes.byteLength < length) {
      throw new Error(`pkg's database ends before byte ${offset + length}`);
    }
    return bytes;
  };
  const header = await read(0, 100);
  if (text.decode(header.subarray(0, 16)) !== "SQLite format 3\0") {
    throw new Error("not a SQLite database");
  }
  const head = new DataView(header.buffer, header.byteOffset, 100);
  if (head.getUint32(56) !== 1) throw new Error("not a UTF-8 database");
  const size = head.getUint16(16) === 1 ? 65536 : head.getUint16(16);
  const usable = size - header[20];
  const page = async (number: number) => {
    const bytes = await exactly((number - 1) * size, size);
    return { bytes, view: new DataView(bytes.buffer, bytes.byteOffset, size) };
  };
  /** A table cell's payload: its local part, then its overflow pages. */
  const payload = async (bytes: Uint8Array, at: number) => {
    const [length, afterLength] = varint(bytes, at);
    const [, body] = varint(bytes, afterLength);
    const max = usable - 35;
    const min = Math.floor((usable - 12) * 32 / 255) - 23;
    const spill = min + (length - min) % (usable - 4);
    const local = length <= max ? length : spill <= max ? spill : min;
    const out = new Uint8Array(length);
    out.set(bytes.subarray(body, body + local));
    let filled = local;
    let next = local < length
      ? new DataView(bytes.buffer, bytes.byteOffset).getUint32(body + local)
      : 0;
    while (filled < length) {
      const overflow = await page(next);
      const take = Math.min(usable - 4, length - filled);
      out.set(overflow.bytes.subarray(4, 4 + take), filled);
      filled += take;
      next = overflow.view.getUint32(0);
    }
    return out;
  };
  /** A record's columns, as far as `last`: text, small integers, or null
   * (and null for the kinds no column read here is). */
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
        values.push(null);
      }
      body += width;
    }
    return values;
  };
  /** Every row of the table b-tree rooted at `root`. */
  const rows = async (root: number, last: number) => {
    const out: (string | number | null)[][] = [];
    const seen = new Set<number>();
    const walk = async (number: number) => {
      if (seen.has(number)) throw new Error(`page ${number} is in a loop`);
      seen.add(number);
      const { bytes, view } = await page(number);
      const at = number === 1 ? 100 : 0;
      const kind = bytes[at];
      const cells = view.getUint16(at + 3);
      const pointers = at + (kind === 5 ? 12 : 8);
      for (let i = 0; i < cells; i++) {
        const cell = view.getUint16(pointers + 2 * i);
        if (kind === 13) out.push(columns(await payload(bytes, cell), last));
        else if (kind === 5) await walk(view.getUint32(cell));
        else throw new Error(`page ${number} is not a table page`);
      }
      if (kind === 5) await walk(view.getUint32(at + 8));
    };
    await walk(root);
    return out;
  };
  // sqlite_schema: type, name, tbl_name, rootpage, sql.
  const table = (await rows(1, 4)).find(([type, name]) =>
    type === "table" && name === "packages"
  );
  if (table === undefined || typeof table[3] !== "number") {
    throw new Error("pkg's database has no packages table");
  }
  const names = columnNames(String(table[4]));
  const name = names.indexOf("name");
  const state = names.indexOf("install_state");
  if (name < 0) throw new Error("pkg's packages table has no name column");
  if (state < 0) {
    throw new Error("pkg's packages table has no install_state column");
  }
  return (await rows(table[3], Math.max(name, state)))
    .filter((row) => row[state] === "installed")
    .map((row) => String(row[name]))
    .sort();
}

/** What pkg has installed in a sandbox whose files `readAt` reads: none
 * when it has no database. A pkg run writing it (its journal there, before
 * or after the read) is waited out once, `retryMs`; a journal still there
 * is a run that died mid-transaction, and an error, as is any read that
 * fails. */
export async function readInstalled(
  readAt: ReadAt,
  retryMs = 500,
): Promise<string[]> {
  const journal = async () =>
    ((await readAt(INSTALLED_DB_JOURNAL, 0, 1))?.byteLength ?? 0) > 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await new Promise((done) => setTimeout(done, retryMs));
    if (await journal()) continue;
    if (await readAt(INSTALLED_DB_PATH, 0, 100) === undefined) return [];
    const names = await installedPackages(async (offset, length) => {
      const bytes = await readAt(INSTALLED_DB_PATH, offset, length);
      if (bytes === undefined) {
        throw new Error("pkg's database went away while it was read");
      }
      return bytes;
    });
    if (!await journal()) return names;
  }
  throw new Error(
    "pkg's database has an unfinished transaction; the next pkg run repairs it",
  );
}
