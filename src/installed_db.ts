/**
 * What `pkg` has installed, read straight out of its database
 * (`/var/lib/yurt-pkg/installed.sqlite`): the page runs no guest process
 * to ask, so the read takes no lock and waits on no install.
 *
 * Just enough of the SQLite file format (https://sqlite.org/fileformat.html)
 * for one table: the schema on page 1 names the `packages` table's root
 * page and its columns; its b-tree's leaf cells are the rows. Only those
 * pages, and of each row only the bytes up to the columns read, are read,
 * each at its offset.
 *
 * pkg opens the file in SQLite's default rollback-journal mode: the main
 * file holds every committed transaction (there is no WAL to merge), a
 * `-journal` beside it means a pkg run is writing, and every commit
 * changes the header's file change counter.
 */

/** Where pkg keeps it, and the journal a pkg run writing it leaves beside
 * it. */
export const INSTALLED_DB_PATH = "/var/lib/yurt-pkg/installed.sqlite";
export const INSTALLED_DB_JOURNAL = `${INSTALLED_DB_PATH}-journal`;

/** Up to `length` bytes of a sandbox file from `offset`, fewer at its end;
 * `undefined` when there is no such file. Any other failure throws. */
export type ReadAt = (
  path: string,
  offset: number,
  length: number,
) => Promise<Uint8Array | undefined>;

/** The header's file change counter: its offset, and how long a pkg run
 * that keeps writing is waited for before the panel says so. */
const CHANGE_COUNTER = 24;
const BUSY_WAIT_MS = 60_000;

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

type Value = string | number | null;

/** A table's columns, in order, from its `CREATE TABLE` text: the first
 * word of each top-level definition (comments skipped), and its DEFAULT --
 * what a row written before an `ADD COLUMN` holds. Table constraints come
 * after every column, so they move no column's position. */
function tableColumns(sql: string): { name: string; fallback: Value }[] {
  const definitions: string[] = [];
  let current = "";
  let depth = 0;
  for (let i = sql.indexOf("(") + 1; i < sql.length; i++) {
    const c = sql[i];
    const close = c === "'" || c === '"' || c === "`"
      ? c
      : c === "["
      ? "]"
      : sql.startsWith("--", i)
      ? "\n"
      : sql.startsWith("/*", i)
      ? "*/"
      : "";
    if (close !== "") {
      const end = sql.indexOf(close, i + 1);
      const stop = end < 0 ? sql.length : end + close.length;
      // A comment is a space; a quoted word stays.
      current += close === "\n" || close === "*/" ? " " : sql.slice(i, stop);
      i = stop - 1;
    } else if (c === "(") {
      depth++;
      current += c;
    } else if (c === ")" && depth === 0) {
      break;
    } else if (c === "," && depth === 0) {
      definitions.push(current);
      current = "";
    } else {
      if (c === ")") depth--;
      current += c;
    }
  }
  definitions.push(current);
  return definitions.map((definition) => {
    const word = definition.trim().match(
      /^(?:"([^"]*)"|`([^`]*)`|\[([^\]]*)\]|([^\s(]+))/,
    );
    const fallback = definition.match(
      /\bDEFAULT\s+(?:'((?:[^']|'')*)'|([-+]?\d+)(?!\.)|NULL\b)/i,
    );
    return {
      name: (word?.slice(1).find((part) => part !== undefined) ?? "")
        .toLowerCase(),
      fallback: fallback?.[1] !== undefined
        ? fallback[1].replaceAll("''", "'")
        : fallback?.[2] !== undefined
        ? Number(fallback[2])
        : null,
    };
  });
}

/** The packages a database records as installed, read with `read`
 * (fewer bytes at its end, `undefined` when there is no such file); its
 * change counter goes to `counted` as soon as it is read. No file, or one
 * too short for a header, has none installed. A row an install has
 * prepared but not finished is not installed. Throws on a file this does
 * not read. */
export async function installedPackages(
  read: (offset: number, length: number) => Promise<Uint8Array | undefined>,
  counted: (counter: number) => void = () => {},
): Promise<string[]> {
  const text = new TextDecoder();
  const header = await read(0, 100);
  // SQLite's own reading of a file too short for a header: empty.
  if (header === undefined || header.byteLength < 100) return [];
  if (text.decode(header.subarray(0, 16)) !== "SQLite format 3\0") {
    throw new Error("not a SQLite database");
  }
  const head = new DataView(header.buffer, header.byteOffset, 100);
  counted(head.getUint32(CHANGE_COUNTER));
  if (head.getUint32(56) !== 1) throw new Error("not a UTF-8 database");
  const size = head.getUint16(16) === 1 ? 65536 : head.getUint16(16);
  const usable = size - header[20];
  const exactly = async (offset: number, length: number) => {
    const bytes = await read(offset, length);
    if (bytes === undefined) {
      throw new Error("pkg's database went away while it was read");
    }
    if (bytes.byteLength < length) {
      throw new Error(`pkg's database ends before byte ${offset + length}`);
    }
    return bytes;
  };
  const page = async (number: number) => {
    const bytes = await exactly((number - 1) * size, size);
    return { bytes, view: new DataView(bytes.buffer, bytes.byteOffset, size) };
  };
  /** The columns of the row in the table cell at `cell`, as far as
   * `columns[last]`: its record's local part, then only as many overflow
   * pages as those columns need. Text, small integers, or null (and null
   * for the kinds no column read here is); a row shorter than the table
   * (written before an ADD COLUMN) has the column's DEFAULT. */
  const row = async (
    bytes: Uint8Array,
    cell: number,
    columns: { fallback: Value }[],
    last: number,
  ) => {
    const [length, afterLength] = varint(bytes, cell);
    const [, body] = varint(bytes, afterLength);
    const max = usable - 35;
    const min = Math.floor((usable - 12) * 32 / 255) - 23;
    const spill = min + (length - min) % (usable - 4);
    const local = length <= max ? length : spill <= max ? spill : min;
    let record = bytes.slice(body, body + local);
    let next = local < length
      ? new DataView(bytes.buffer, bytes.byteOffset).getUint32(body + local)
      : 0;
    /** The record's first `want` bytes (or all of it) are in `record`. */
    const need = async (want: number) => {
      while (record.byteLength < Math.min(want, length)) {
        const overflow = await page(next);
        const take = Math.min(usable - 4, length - record.byteLength);
        const longer = new Uint8Array(record.byteLength + take);
        longer.set(record);
        longer.set(overflow.bytes.subarray(4, 4 + take), record.byteLength);
        record = longer;
        next = overflow.view.getUint32(0);
      }
    };
    await need(9);
    const [headerSize] = varint(record, 0);
    await need(headerSize);
    let at = varint(record, 0)[1];
    const types: number[] = [];
    while (at < headerSize && types.length <= last) {
      let type: number;
      [type, at] = varint(record, at);
      types.push(type);
    }
    const width = (type: number) =>
      type >= 12
        ? Math.floor((type - 12) / 2)
        : [0, 1, 2, 3, 4, 6, 8, 8, 0, 0][type];
    await need(headerSize + types.reduce((sum, type) => sum + width(type), 0));
    const values: Value[] = [];
    let offset = headerSize;
    for (const type of types) {
      if (type >= 13 && type % 2 === 1) {
        values.push(text.decode(record.subarray(offset, offset + width(type))));
      } else if (type >= 1 && type <= 4) {
        let value = 0;
        for (let i = 0; i < width(type); i++) {
          value = value * 256 + record[offset + i];
        }
        values.push(value);
      } else if (type === 8 || type === 9) {
        values.push(type - 8);
      } else {
        values.push(null);
      }
      offset += width(type);
    }
    for (let i = values.length; i <= last; i++) {
      values.push(columns[i]?.fallback ?? null);
    }
    return values;
  };
  /** Every row of the table b-tree rooted at `root`. */
  const rows = async (
    root: number,
    columns: { fallback: Value }[],
    last: number,
  ) => {
    const out: Value[][] = [];
    const seen = new Set<number>();
    const walk = async (number: number) => {
      if (seen.has(number)) throw new Error(`page ${number} is in a loop`);
      seen.add(number);
      const { bytes, view } = number === 1
        ? { bytes: first, view: new DataView(first.buffer, first.byteOffset) }
        : await page(number);
      const at = number === 1 ? 100 : 0;
      const kind = bytes[at];
      const cells = view.getUint16(at + 3);
      const pointers = at + (kind === 5 ? 12 : 8);
      for (let i = 0; i < cells; i++) {
        const cell = view.getUint16(pointers + 2 * i);
        if (kind === 13) out.push(await row(bytes, cell, columns, last));
        else if (kind === 5) await walk(view.getUint32(cell));
        else throw new Error(`page ${number} is not a table page`);
      }
      if (kind === 5) await walk(view.getUint32(at + 8));
    };
    await walk(root);
    return out;
  };
  // Page 1 holds the header just read; the rest of it is read once.
  const first = new Uint8Array(size);
  first.set(header);
  first.set(await exactly(100, size - 100), 100);
  // sqlite_schema: type, name, tbl_name, rootpage, sql.
  const table = (await rows(1, [], 4)).find(([type, name]) =>
    type === "table" && name === "packages"
  );
  if (table === undefined || typeof table[3] !== "number") {
    throw new Error("pkg's database has no packages table");
  }
  const columns = tableColumns(String(table[4]));
  const names = columns.map((column) => column.name);
  const name = names.indexOf("name");
  const state = names.indexOf("install_state");
  if (name < 0) throw new Error("pkg's packages table has no name column");
  if (state < 0) {
    throw new Error("pkg's packages table has no install_state column");
  }
  return (await rows(table[3], columns, Math.max(name, state)))
    .filter((values) => values[state] === "installed")
    .map((values) => String(values[name]))
    .sort();
}

/** What pkg has installed in a sandbox whose files `readAt` reads: none
 * when it has no database. A read is answered only when no pkg run wrote
 * the database meanwhile: no journal after it, and the same change
 * counter. Otherwise it is read again after `wait` (doubling, up to 4 s),
 * for up to a minute of waiting; past that it says pkg is still writing.
 * Any other failure throws. `undefined` once `live` says the sandbox is not
 * the one the read began in (checked after every read and wait): it is not
 * read on, and nothing it read is answered. */
export async function readInstalled(
  readAt: ReadAt,
  live: () => boolean = () => true,
  wait: (ms: number) => Promise<void> = (ms) =>
    new Promise((done) => setTimeout(done, ms)),
): Promise<string[] | undefined> {
  const gone = new Error("the sandbox was dropped");
  const read: ReadAt = async (path, offset, length) => {
    const bytes = await readAt(path, offset, length);
    if (!live()) throw gone;
    return bytes;
  };
  try {
    return await readWhenSettled(read, live, wait);
  } catch (error) {
    if (error === gone) return undefined;
    throw error;
  }
}

async function readWhenSettled(
  readAt: ReadAt,
  live: () => boolean,
  wait: (ms: number) => Promise<void>,
): Promise<string[] | undefined> {
  let waited = 0;
  let delay = 250;
  for (;;) {
    let counter: number | undefined;
    let names: string[] = [];
    let failure: unknown;
    try {
      names = await installedPackages(
        (offset, length) => readAt(INSTALLED_DB_PATH, offset, length),
        (read) => counter = read,
      );
    } catch (error) {
      failure = error;
    }
    const busy =
      ((await readAt(INSTALLED_DB_JOURNAL, 0, 1))?.byteLength ?? 0) > 0;
    const now = busy || counter === undefined
      ? undefined
      : await readAt(INSTALLED_DB_PATH, CHANGE_COUNTER, 4);
    const moved = now !== undefined &&
      (now.byteLength < 4 ||
        new DataView(now.buffer, now.byteOffset).getUint32(0) !== counter);
    // A file that went away mid-read was replaced or removed: read again.
    const vanished = counter !== undefined && now === undefined && !busy;
    if (!busy && !moved && !vanished) {
      if (failure !== undefined) throw failure;
      return names;
    }
    if (waited >= BUSY_WAIT_MS) {
      throw new Error(
        "pkg is still writing its database; it is read again when the panel next opens",
      );
    }
    await wait(delay);
    if (!live()) return undefined;
    waited += delay;
    delay = Math.min(delay * 2, 4000);
  }
}
