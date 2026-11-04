/**
 * A YurtFS root store's export, as one zip entry (src/sandbox_snapshot.ts):
 * the log of the export sink's calls, which a restore replays into a
 * fresh store. Store format v2 (yurtos-kernel
 * docs/superpowers/specs/2026-11-03-yurtfs-per-inode-storage-amendment.md
 * section 7): the barrier exports each regular file's own host file
 * (`content/<ino>`), then the active journal, then `meta` last, in pieces
 * of at most {@link STORE_PIECE_BYTES} at offsets that are multiples of
 * it. All-zero pieces are skipped, and each file ends with a length call,
 * so holes stay holes on both sides of the zip.
 *
 * One entry rather than one per file: a store has up to 400,000 content
 * files (the kernel's inode cap), past the 65,535 entries a zip without
 * zip64 holds, and the log keeps the holes the export left.
 *
 * This file is plain data handling and imports no kernel code.
 */

/** The export's piece: `PIECE` in yurtos-kernel
 * packages/kernel/src/vfs/packed_store/export.rs. */
export const STORE_PIECE_BYTES = 64 * 1024;

/** A store file an export names: a regular file's content (`content/`
 * then its inode number in decimal, no leading zeros), the active
 * journal, or `meta`. `lock`, the inactive journal and `lower.tar` are
 * never exported: the copy is completed, and its lower materialized,
 * where it is restored. */
export type StoreFileName =
  | `content/${string}`
  | "journal-a"
  | "journal-b"
  | "meta";

/** A u64 inode number in decimal, no leading zeros. */
const INO = /^content\/[1-9][0-9]{0,19}$/;
const U64_MAX = 2n ** 64n - 1n;

/** Whether `name` is a file a store export may name. */
export function isStoreFileName(name: string): name is StoreFileName {
  return name === "journal-a" || name === "journal-b" || name === "meta" ||
    (INO.test(name) && BigInt(name.slice("content/".length)) <= U64_MAX);
}

/** How many files an export named, and their lengths' sum. */
export type StoreTotals = { files: number; bytes: number };

/**
 * The order an export's calls must keep, checked call by call (a seal's
 * sink, and a restore's replay of the log, use the same one):
 * - every `content/<ino>` first, each once, then one journal, then
 *   `meta`, and nothing after it;
 * - a file's pieces at increasing offsets that are multiples of
 *   {@link STORE_PIECE_BYTES}, each 1 to that many bytes, a short one only
 *   as its last; then its length, past its last piece (the end of a short
 *   one exactly), which closes it.
 *
 * Every refusal is a throw saying what broke.
 */
export class StoreExportOrder {
  #seen = new Set<string>();
  /** 0: content files; 1: the journal is open; 2: the journal is closed,
   * `meta` is next; 3: `meta` is open; 4: `meta` is closed, the end. */
  #phase = 0;
  #open?: { name: StoreFileName; end: number; short: boolean };
  #totals: StoreTotals = { files: 0, bytes: 0 };

  #begin(name: string): { name: StoreFileName; end: number; short: boolean } {
    if (this.#open?.name === name) return this.#open;
    if (this.#open !== undefined) {
      throw new Error(
        `the store export moved to ${name} before giving ${this.#open.name} its length`,
      );
    }
    if (!isStoreFileName(name)) {
      throw new Error(`the store export names ${JSON.stringify(name)}`);
    }
    if (this.#seen.has(name)) {
      throw new Error(`the store export went back to ${name}`);
    }
    const next = name.startsWith("content/")
      ? (this.#phase === 0 ? 0 : -1)
      : name === "meta"
      ? (this.#phase === 2 ? 3 : -1)
      : (this.#phase === 0 ? 1 : -1);
    if (next < 0) {
      throw new Error(
        `the store export gives ${name} after ${
          [...this.#seen].at(-1) ?? "nothing"
        }: content files, then the active journal, then meta`,
      );
    }
    this.#phase = next;
    this.#seen.add(name);
    this.#open = { name, end: 0, short: false };
    return this.#open;
  }

  /** A piece of `size` bytes of `name` at `offset`. */
  write(name: string, offset: number, size: number): StoreFileName {
    const open = this.#begin(name);
    if (
      !Number.isSafeInteger(offset) || offset % STORE_PIECE_BYTES !== 0 ||
      offset < open.end || open.short
    ) {
      throw new Error(
        `the store export wrote ${name} at ${offset}, not at a piece boundary past ${open.end}`,
      );
    }
    if (!Number.isInteger(size) || size < 1 || size > STORE_PIECE_BYTES) {
      throw new Error(
        `the store export wrote ${size} bytes of ${name}, not 1 to ${STORE_PIECE_BYTES}`,
      );
    }
    open.end = offset + size;
    open.short = size < STORE_PIECE_BYTES;
    return open.name;
  }

  /** `name`'s length, which closes it. */
  setLength(name: string, length: number): StoreFileName {
    const open = this.#begin(name);
    if (
      !Number.isSafeInteger(length) || length < open.end ||
      (open.short && length !== open.end)
    ) {
      throw new Error(
        `the store export gave ${name} the length ${length}, short of or past its last piece's end ${open.end}`,
      );
    }
    this.#open = undefined;
    this.#totals.files++;
    this.#totals.bytes += length;
    if (this.#phase === 1) this.#phase = 2;
    else if (this.#phase === 3) this.#phase = 4;
    return open.name;
  }

  /** The totals of a whole export: one that ended with `meta` closed. */
  finish(): StoreTotals {
    if (this.#phase !== 4) {
      throw new Error(
        "the store export ended before meta" +
          (this.#open === undefined ? "" : ` (in ${this.#open.name})`),
      );
    }
    return { ...this.#totals };
  }

  /** The closed files' totals so far, and the open file's end. */
  get extent(): StoreTotals & { open: number | undefined } {
    return { ...this.#totals, open: this.#open?.end };
  }
}

/** Log record tags: a piece (`P`, offset u64, size u32, bytes) and a
 * file's length (`L`, length u64), each after its name (u8 length, then
 * ASCII). Little-endian. */
const PIECE_TAG = 0x50;
const LENGTH_TAG = 0x4c;
/** Tag, name length, the longest name, and a u64. */
const HEAD_MAX = 1 + 1 + "content/".length + 20 + 8 + 4;

function head(tag: number, name: string, value: number, size?: number) {
  const nameBytes = new TextEncoder().encode(name);
  const out = new Uint8Array(
    2 + nameBytes.byteLength + 8 + (size === undefined ? 0 : 4),
  );
  const view = new DataView(out.buffer);
  out[0] = tag;
  out[1] = nameBytes.byteLength;
  out.set(nameBytes, 2);
  view.setBigUint64(2 + nameBytes.byteLength, BigInt(value), true);
  if (size !== undefined) {
    view.setUint32(2 + nameBytes.byteLength + 8, size, true);
  }
  return out;
}

/** An export written down as it is handed over: a seal's sink, giving
 * the log's chunks (the pieces copied once, since the export may reuse
 * its buffer; never joined) and its totals. */
export class StoreLogWriter {
  #order = new StoreExportOrder();
  readonly chunks: Uint8Array[] = [];

  write(name: string, offset: number, bytes: Uint8Array): void {
    this.#order.write(name, offset, bytes.byteLength);
    this.chunks.push(head(PIECE_TAG, name, offset, bytes.byteLength));
    this.chunks.push(bytes.slice());
  }

  setLength(name: string, length: number): void {
    this.#order.setLength(name, length);
    this.chunks.push(head(LENGTH_TAG, name, length));
  }

  finish(): StoreTotals {
    return this.#order.finish();
  }
}

/** Where a replayed log goes: a fresh store (src/root_store.ts). */
export type StoreLogTarget = {
  write(name: StoreFileName, offset: number, bytes: Uint8Array): unknown;
  setLength(name: StoreFileName, length: number): unknown;
};

/**
 * Replays a log, fed in chunks of any size, into `target`, in the order
 * the export made its calls, after checking each against
 * {@link StoreExportOrder} and against `bound` (the pin's record of the
 * whole export): no call ever names more files or more bytes than it
 * says, so a log that has not passed its hash yet writes no more than the
 * pinned store would. {@link finish} requires the whole export, exactly
 * `bound`.
 */
export class StoreLogReader {
  #order = new StoreExportOrder();
  #target: StoreLogTarget;
  #bound: StoreTotals;
  #pending: Uint8Array = new Uint8Array(0);

  constructor(target: StoreLogTarget, bound: StoreTotals) {
    this.#target = target;
    this.#bound = bound;
  }

  /** Replay every whole record `chunk` completes. */
  async push(chunk: Uint8Array): Promise<void> {
    let bytes = chunk;
    if (this.#pending.byteLength > 0) {
      bytes = new Uint8Array(this.#pending.byteLength + chunk.byteLength);
      bytes.set(this.#pending);
      bytes.set(chunk, this.#pending.byteLength);
    }
    let at = 0;
    for (;;) {
      const used = await this.#record(bytes.subarray(at));
      if (used === 0) break;
      at += used;
    }
    // A record is at most a head and a piece: what is kept stays bounded.
    this.#pending = bytes.slice(at);
  }

  /** Replay the record at the start of `bytes`; its length, or 0 when it
   * is not all there yet. */
  async #record(bytes: Uint8Array): Promise<number> {
    if (bytes.byteLength < 2) return 0;
    const tag = bytes[0];
    if (tag !== PIECE_TAG && tag !== LENGTH_TAG) {
      throw new Error(`the store log holds a record tagged ${tag}`);
    }
    const nameEnd = 2 + bytes[1];
    const headEnd = nameEnd + 8 + (tag === PIECE_TAG ? 4 : 0);
    if (headEnd > HEAD_MAX) {
      throw new Error("the store log names a file past its longest name");
    }
    if (bytes.byteLength < headEnd) return 0;
    const view = new DataView(bytes.buffer, bytes.byteOffset);
    const name = new TextDecoder().decode(bytes.subarray(2, nameEnd));
    const value = view.getBigUint64(nameEnd, true);
    const number = value > BigInt(Number.MAX_SAFE_INTEGER)
      ? Number.NaN
      : Number(value);
    if (tag === LENGTH_TAG) {
      const file = this.#order.setLength(name, number);
      this.#within(name);
      await this.#target.setLength(file, number);
      return headEnd;
    }
    const size = view.getUint32(nameEnd + 8, true);
    // Before its bytes are waited for: what is kept stays one piece.
    if (size > STORE_PIECE_BYTES) {
      throw new Error(
        `the store log holds a piece of ${size} bytes of ${name}, past ${STORE_PIECE_BYTES}`,
      );
    }
    if (bytes.byteLength < headEnd + size) return 0;
    const file = this.#order.write(name, number, size);
    this.#within(name);
    await this.#target.write(
      file,
      number,
      bytes.subarray(headEnd, headEnd + size),
    );
    return headEnd + size;
  }

  /** The files and bytes so far, the open file's included, within the
   * bound. */
  #within(name: string): void {
    const { files, bytes, open } = this.#order.extent;
    if (
      files + (open === undefined ? 0 : 1) > this.#bound.files ||
      bytes + (open ?? 0) > this.#bound.bytes
    ) {
      throw new Error(
        `the store log's ${name} goes past the pinned store's ${this.#bound.files} files of ${this.#bound.bytes} bytes`,
      );
    }
  }

  /** The end of the log: the whole export, exactly the bound. */
  finish(): void {
    if (this.#pending.byteLength !== 0) {
      throw new Error("the store log ends inside a record");
    }
    const totals = this.#order.finish();
    if (
      totals.files !== this.#bound.files || totals.bytes !== this.#bound.bytes
    ) {
      throw new Error(
        `the store log holds ${totals.files} files of ${totals.bytes} bytes, ` +
          `not the pinned ${this.#bound.files} of ${this.#bound.bytes}`,
      );
    }
  }
}
