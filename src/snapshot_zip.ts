/**
 * The zip a sandbox snapshot is (src/sandbox_snapshot.ts): written whole
 * at a capture, read as a stream at a restore, entry by entry, without
 * holding the file.
 *
 * Only what that needs: entries stored or deflated, each with its sizes
 * and CRC-32 in its local header (no data descriptor, so a reader knows
 * where an entry ends before reading it), no zip64 (an entry or the file
 * past 4 GiB is refused), no encryption, fixed timestamps. Any unzip tool
 * reads it. The reader checks CRC-32s only when asked (the release
 * tools, whose file has no other check): a restore checks the whole
 * file's sha256, which the pin records, as it downloads
 * (fetchVerifiedSnapshot), and a CRC over the ~550 MB of kernel memory
 * would only cost it.
 */

const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const END = 0x06054b50;
const STORED = 0;
const DEFLATED = 8;
/** 1980-01-01 00:00, the earliest DOS date: a capture's bytes do not
 * depend on when it ran. */
const DOS_DATE = (0 << 9) | (1 << 5) | 1;
const LIMIT = 0xffff_ffff;

let crcTable: Uint32Array | undefined;

export function crc32(bytes: Uint8Array, crc = 0): number {
  if (crcTable === undefined) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = ~crc >>> 0;
  for (let i = 0; i < bytes.byteLength; i++) {
    c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return ~c >>> 0;
}

export type ZipEntryInput = {
  name: string;
  /** Its contents, whole or as the chunks they were handed over in:
   * streamed into the zip, never joined. */
  bytes: Uint8Array | Uint8Array[];
  /** Deflated, else stored. */
  deflate: boolean;
};

/** The `[start, end)` ranges of `byteLength` bytes in 1 MiB steps:
 * multiplied, never shifted, so offsets past 2 GiB stay positive. */
export function chunkRanges(byteLength: number): [number, number][] {
  const step = 2 ** 20;
  return Array.from(
    { length: Math.ceil(byteLength / step) },
    (_, i) => [i * step, Math.min((i + 1) * step, byteLength)],
  );
}

/** `chunks` as a stream, in 1 MiB views: no copy of a chunk is made. */
function streamOf(
  chunks: Uint8Array[],
): ReadableStream<Uint8Array<ArrayBuffer>> {
  const views = chunks.flatMap((chunk) =>
    chunkRanges(chunk.byteLength).map(([start, end]) =>
      chunk.subarray(start, end) as Uint8Array<ArrayBuffer>
    )
  );
  let next = 0;
  return new ReadableStream({
    pull(controller) {
      if (next < views.length) controller.enqueue(views[next++]);
      else controller.close();
    },
  });
}

/** A zip of `entries`, in their order. */
export async function writeZip(entries: ZipEntryInput[]): Promise<Blob> {
  const body: BlobPart[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const { name, bytes, deflate } of entries) {
    const chunks = bytes instanceof Uint8Array ? [bytes] : bytes;
    const size = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const data = deflate
      ? await new Response(
        streamOf(chunks).pipeThrough(new CompressionStream("deflate-raw")),
      ).blob()
      : new Blob(chunks as Uint8Array<ArrayBuffer>[]);
    if (size >= LIMIT || data.size >= LIMIT) {
      throw new Error(`zip entry ${name} is too large without zip64`);
    }
    const fields = {
      method: deflate ? DEFLATED : STORED,
      crc: chunks.reduce((crc, chunk) => crc32(chunk, crc), 0),
      compressed: data.size,
      size,
      name: new TextEncoder().encode(name),
    };
    const local = header(LOCAL, fields, offset);
    body.push(local, data);
    central.push(header(CENTRAL, fields, offset));
    offset += local.byteLength + data.size;
    if (offset >= LIMIT) throw new Error("zip is too large without zip64");
  }
  const centralBytes = central.reduce(
    (sum, entry) => sum + entry.byteLength,
    0,
  );
  const end = new Uint8Array(22);
  const view = new DataView(end.buffer);
  view.setUint32(0, END, true);
  view.setUint16(8, entries.length, true);
  view.setUint16(10, entries.length, true);
  view.setUint32(12, centralBytes, true);
  view.setUint32(16, offset, true);
  return new Blob([...body, ...central as Uint8Array<ArrayBuffer>[], end]);
}

/** A local (30 bytes + name) or central (46 bytes + name) header. */
function header(
  signature: number,
  entry: {
    method: number;
    crc: number;
    compressed: number;
    size: number;
    name: Uint8Array;
  },
  offset: number,
): Uint8Array<ArrayBuffer> {
  const central = signature === CENTRAL;
  const fixed = central ? 46 : 30;
  const out = new Uint8Array(fixed + entry.name.byteLength);
  const view = new DataView(out.buffer);
  let at = 0;
  const u16 = (value: number) => (view.setUint16(at, value, true), at += 2);
  const u32 = (value: number) => (view.setUint32(at, value, true), at += 4);
  u32(signature);
  if (central) u16(20); // version made by
  u16(20); // version needed: deflate
  u16(0); // flags: sizes here, no data descriptor
  u16(entry.method);
  u16(0); // time
  u16(DOS_DATE);
  u32(entry.crc);
  u32(entry.compressed);
  u32(entry.size);
  u16(entry.name.byteLength);
  u16(0); // extra
  if (central) {
    u16(0); // comment
    u16(0); // disk
    u16(0); // internal attributes
    u32(0); // external attributes
    u32(offset);
  }
  out.set(entry.name, at);
  return out;
}

export type ZipEntry = {
  name: string;
  crc: number;
  /** Uncompressed. */
  size: number;
  compressed: number;
  method: number;
};

/** A zip read front to back from a stream: each entry's header, then its
 * contents, in file order. */
export class ZipStreamReader {
  #reader: ReadableStreamDefaultReader<Uint8Array>;
  #pending: Uint8Array = new Uint8Array(0);
  /** The part of a stream chunk {@link #fill} did not need: a short
   * header joins only the bytes it needs, never a whole (20 MiB) chunk. */
  #rest: Uint8Array | undefined;
  #entries = 0;
  #checkCrc: boolean;

  constructor(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    { checkCrc = false } = {},
  ) {
    this.#reader = reader;
    this.#checkCrc = checkCrc;
  }

  /** The next stream chunk: the rest {@link #fill} left first. */
  async #next(): Promise<ReadableStreamReadResult<Uint8Array>> {
    const rest = this.#rest;
    if (rest === undefined) return await this.#reader.read();
    this.#rest = undefined;
    return { done: false, value: rest };
  }

  /** At least `bytes` bytes buffered, or fewer at the end of the stream. */
  async #fill(bytes: number): Promise<void> {
    while (this.#pending.byteLength < bytes) {
      const { done, value } = await this.#next();
      if (done) return;
      if (this.#pending.byteLength === 0) {
        this.#pending = value;
        continue;
      }
      const need = Math.min(bytes - this.#pending.byteLength, value.byteLength);
      const joined = new Uint8Array(this.#pending.byteLength + need);
      joined.set(this.#pending);
      joined.set(value.subarray(0, need), this.#pending.byteLength);
      this.#pending = joined;
      if (need < value.byteLength) this.#rest = value.subarray(need);
    }
  }

  async #take(bytes: number, what: string): Promise<Uint8Array> {
    await this.#fill(bytes);
    if (this.#pending.byteLength < bytes) {
      throw new Error(`sandbox snapshot is truncated (in ${what})`);
    }
    const out = this.#pending.subarray(0, bytes);
    this.#pending = this.#pending.subarray(bytes);
    return out;
  }

  /** The next entry's header, or undefined where the central directory
   * begins (the entries are over). */
  async next(): Promise<ZipEntry | undefined> {
    const fixed = await this.#take(30, "a zip entry header");
    const view = new DataView(fixed.buffer, fixed.byteOffset, 30);
    const signature = view.getUint32(0, true);
    if (signature === CENTRAL) {
      this.#pending = joinBytes(fixed, this.#pending);
      return undefined;
    }
    if (signature !== LOCAL) {
      throw new Error(
        (signature & 0xffff) === 0x8b1f
          ? "sandbox snapshot is a gzip, not a zip"
          : "sandbox snapshot is not a zip (no entry header)",
      );
    }
    const flags = view.getUint16(6, true);
    const method = view.getUint16(8, true);
    if ((flags & 0x9) !== 0) {
      throw new Error(
        "sandbox snapshot zip entry is encrypted or has a data descriptor",
      );
    }
    if (method !== STORED && method !== DEFLATED) {
      throw new Error(`sandbox snapshot zip entry method ${method}`);
    }
    const nameBytes = view.getUint16(26, true);
    const extra = view.getUint16(28, true);
    const name = new TextDecoder().decode(
      await this.#take(nameBytes, "a zip entry name"),
    );
    await this.#take(extra, "a zip entry header");
    this.#entries++;
    return {
      name,
      crc: view.getUint32(14, true),
      method,
      compressed: view.getUint32(18, true),
      size: view.getUint32(22, true),
    };
  }

  /** `entry`'s contents, in order, to `take`; exactly its size, and its
   * CRC-32 when the reader checks them. */
  async read(
    entry: ZipEntry,
    give: (chunk: Uint8Array, offset: number) => void | Promise<void>,
  ): Promise<void> {
    let crc = 0;
    const take = this.#checkCrc
      ? (chunk: Uint8Array, offset: number) => {
        crc = crc32(chunk, crc);
        return give(chunk, offset);
      }
      : give;
    await this.#readEntry(entry, take);
    if (this.#checkCrc && crc !== entry.crc) {
      throw new Error(
        `zip entry ${entry.name} fails its CRC-32: ${crc}, not ${entry.crc}`,
      );
    }
  }

  async #readEntry(
    entry: ZipEntry,
    take: (chunk: Uint8Array, offset: number) => void | Promise<void>,
  ): Promise<void> {
    if (entry.method === STORED) {
      if (entry.compressed !== entry.size) {
        throw new Error(`zip entry ${entry.name} is stored but resized`);
      }
      await this.#copy(entry.compressed, entry.name, take);
      return;
    }
    const inflater = new DecompressionStream("deflate-raw");
    const writer = inflater.writable.getWriter();
    /** Why the pump failed (a truncated file), when it failed first. */
    let pumpError: unknown;
    const pumped = (async () => {
      try {
        await this.#copy(
          entry.compressed,
          entry.name,
          (chunk) => writer.write(chunk as Uint8Array<ArrayBuffer>),
        );
        await writer.close();
      } catch (error) {
        pumpError ??= error;
        await writer.abort(error).catch(() => {});
        throw error;
      }
    })();
    pumped.catch(() => {});
    const reader = inflater.readable.getReader();
    let at = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (at + value.byteLength > entry.size) {
          throw new Error(
            `zip entry ${entry.name} inflates past its ${entry.size} bytes`,
          );
        }
        await take(value, at);
        at += value.byteLength;
      }
    } catch (error) {
      // The pump failed first (a truncated file): its reason, not the
      // inflater's.
      if (pumpError !== undefined) throw pumpError;
      // Nothing reads the inflater now: cancel it, or a pump held back by
      // its backpressure (a TransformStream's, per the Streams spec) would
      // wait forever.
      pumpError = error;
      await reader.cancel(error).catch(() => {});
      await pumped.catch(() => {});
      throw error;
    }
    await pumped;
    if (at !== entry.size) {
      throw new Error(
        `zip entry ${entry.name} inflates to ${at} bytes, not ${entry.size}`,
      );
    }
  }

  /** `entry`'s contents whole, refused past `max` bytes. */
  async readWhole(entry: ZipEntry, max: number): Promise<Uint8Array> {
    if (entry.size > max) {
      throw new Error(`zip entry ${entry.name} is over ${max} bytes`);
    }
    const out = new Uint8Array(entry.size);
    await this.read(entry, (chunk, offset) => out.set(chunk, offset));
    return out;
  }

  /** The next `bytes` raw bytes to `take`, streamed. */
  async #copy(
    bytes: number,
    what: string,
    take: (chunk: Uint8Array, offset: number) => unknown,
  ): Promise<void> {
    let had = 0;
    while (had < bytes) {
      if (this.#pending.byteLength === 0) {
        const { done, value } = await this.#next();
        if (done) {
          throw new Error(
            `sandbox snapshot is truncated (${had} of ${bytes} bytes of ${what})`,
          );
        }
        this.#pending = value;
      }
      const chunk = this.#pending.subarray(
        0,
        Math.min(bytes - had, this.#pending.byteLength),
      );
      this.#pending = this.#pending.subarray(chunk.byteLength);
      await take(chunk, had);
      had += chunk.byteLength;
    }
  }

  /** Once {@link next} found the central directory: read the rest of
   * the stream, which must end with the end-of-central-directory record
   * naming as many entries as were read. A stream that checks the file's
   * hash at its end (fetchVerifiedSnapshot) says so here. */
  async finish(): Promise<void> {
    // The directory is ~70 bytes an entry: a "rest" this long is not one.
    await this.#fill(1 << 20);
    const rest = this.#pending;
    const { done } = await this.#next();
    if (!done || rest.byteLength >= 1 << 20) {
      throw new Error("sandbox snapshot runs on past its central directory");
    }
    const at = rest.byteLength - 22;
    const view = new DataView(rest.buffer, rest.byteOffset, rest.byteLength);
    if (at < 0 || view.getUint32(at, true) !== END) {
      throw new Error(
        "sandbox snapshot is truncated (no end of central directory)",
      );
    }
    if (view.getUint16(at + 10, true) !== this.#entries) {
      throw new Error(
        `sandbox snapshot's central directory names ${
          view.getUint16(at + 10, true)
        } entries, not the ${this.#entries} it holds`,
      );
    }
  }
}

function joinBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(a);
  out.set(b, a.byteLength);
  return out;
}
