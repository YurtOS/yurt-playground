/**
 * A sandbox with the Python set already installed, shipped as a sealed
 * kernel (`?snapshot=1`): the page restores it instead of booting the slim
 * image and running `pkg install` (~9,250 files) on every visit.
 *
 * The seal is taken with no guest process alive -- after the install, the
 * shell killed and every helper reaped, before Jupyter -- so the image is
 * the kernel's memory alone (its ramfs holds the whole filesystem) and the
 * restore brings back no process to rewind: the page then starts its shell
 * and Jupyter on it as after a boot.
 *
 * File: gzip of `u32 header length (LE) | header JSON | kernel memory`.
 * Bigints in the header are written as `{"$bigint": "<decimal>"}`. The
 * header says what the sandbox was built from ({@link SnapshotIdentity});
 * a restore under anything else is refused before the memory is read.
 *
 * Once the kernel's root is a YurtFS store, the memory alone no longer
 * holds the files: format 4 puts the store's exported files between the
 * header and the memory, in export order (`data`, the active journal,
 * `meta`), and the header names each one's size and sha256 and the
 * store's identity (src/root_store.ts). A restore writes them into a
 * fresh store, checks the identity it replays to, and only then reads the
 * memory.
 *
 * The file is published as a yurt-playground release by
 * scripts/release-snapshot.ts, pinned in artifacts/pins.json (`snapshot`:
 * its parts' sha256s and what it was built from), fetched into the site by
 * scripts/install-pinned-artifacts.sh, and checked part by part as the page
 * downloads it.
 */
import type { SandboxSealImage } from "@yurt/kernel-host-interface-js";
import { sha256Hex } from "./integrity.ts";
import {
  type BuiltFrom,
  parseStorePin,
  type SnapshotIdentity,
  type SnapshotPin,
  STORE_FORMAT,
  type StoreIdentity,
  type StorePin,
} from "./pins.ts";
import {
  identityMismatch,
  type PageSeal,
  type StoreRestoreTarget,
} from "./root_store.ts";
import {
  buildMismatch,
  formatRefusal,
  SEAL_VERSION,
  type SnapshotContents,
  snapshotFormat,
  SnapshotMismatch,
} from "./snapshot_pin.ts";

// The pins half, kernel-free (src/snapshot_pin.ts), for this module's
// existing importers. Code the desktop app or the local server loads
// imports src/snapshot_pin.ts itself.
export * from "./snapshot_pin.ts";

/** The host's seal image version is the one this page writes and
 * restores: a host with another version fails the type check here until
 * SEAL_VERSION follows it. */
const _hostSealVersion: SandboxSealImage["version"] = SEAL_VERSION;

type Header = Omit<SandboxSealImage, "kernelMemory" | "processes"> & {
  format: number;
  builtFrom: BuiltFrom;
  memoryBytes: number;
  /** What it holds; absent in a capture made before it was recorded. */
  contents?: SnapshotContents;
  /** Format 4: the root store's files, which come before the memory. */
  store?: StorePin;
};

function replacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? { $bigint: value.toString() } : value;
}

function reviver(_key: string, value: unknown): unknown {
  if (
    value !== null && typeof value === "object" && "$bigint" in value &&
    Object.keys(value).length === 1
  ) {
    return BigInt((value as { $bigint: string }).$bigint);
  }
  return value;
}

/** The snapshot file for `image`, a seal with no process in it: format 4
 * when it was taken with its root store, else 3. */
export async function encodeSandboxSnapshot(
  image: PageSeal,
  builtFrom: BuiltFrom,
  contents?: SnapshotContents,
): Promise<Blob> {
  if (image.processes.length !== 0) {
    throw new Error(
      `a sandbox snapshot holds no process; this seal has ${image.processes.length}`,
    );
  }
  const { kernelMemory, processes: _processes, rootStore, ...rest } = image;
  const files = rootStore?.files ?? [];
  const header: Header = {
    ...rest,
    format: snapshotFormat(rootStore !== undefined),
    builtFrom,
    memoryBytes: kernelMemory.byteLength,
    ...(contents === undefined ? {} : { contents }),
    ...(rootStore === undefined ? {} : {
      store: {
        identity: rootStore.identity,
        files: await Promise.all(files.map(async ({ name, bytes }) => ({
          name,
          bytes: bytes.byteLength,
          sha256: await sha256Hex(bytes),
        }))),
        lower: rootStore.lower,
      },
    }),
  };
  // A store the kernel exported out of order is not written at all.
  if (header.store !== undefined) {
    parseStorePin(header.store, (what) => {
      throw new Error(`cannot write the snapshot: ${what}`);
    });
  }
  const json = new TextEncoder().encode(JSON.stringify(header, replacer));
  const length = new Uint8Array(4);
  new DataView(length.buffer).setUint32(0, json.byteLength, true);
  // The seal copied the memory out (`slice`), so its buffer is plain.
  const raw = new Blob([
    length,
    json,
    ...files.map(({ bytes }) => bytes as Uint8Array<ArrayBuffer>),
    kernelMemory as Uint8Array<ArrayBuffer>,
  ]);
  return await new Response(
    raw.stream().pipeThrough(new CompressionStream("gzip")),
  ).blob();
}

/** Read up to the end of the header; the bytes after it come back as
 * `rest`, the remainder stays in `reader`. */
async function readHeader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<{ header: Partial<Header>; rest: Uint8Array }> {
  let pending = new Uint8Array(0);
  for (;;) {
    const { done, value } = await reader.read();
    if (done) throw new Error("sandbox snapshot is truncated (no header)");
    const joined = new Uint8Array(pending.byteLength + value.byteLength);
    joined.set(pending);
    joined.set(value, pending.byteLength);
    pending = joined;
    if (pending.byteLength < 4) continue;
    const length = new DataView(pending.buffer).getUint32(0, true);
    if (pending.byteLength < 4 + length) continue;
    return {
      header: JSON.parse(
        new TextDecoder().decode(pending.subarray(4, 4 + length)),
        reviver,
      ),
      rest: pending.subarray(4 + length),
    };
  }
}

/** Why a file's header is not one this page restores under `expected`:
 * another format (for a kernel whose root is, or is not, a store;
 * `rootStore` undefined takes either), another build, or a store entry
 * that is malformed. */
function headerMismatch(
  header: Partial<Header>,
  expected: SnapshotIdentity | BuiltFrom,
  rootStore: boolean | undefined,
): string | undefined {
  if (header.builtFrom !== undefined) {
    const refused = formatRefusal(header.format, rootStore);
    if (refused !== undefined) {
      return `sandbox snapshot header is ${refused}`;
    }
    if ((header.format === STORE_FORMAT) !== (header.store !== undefined)) {
      return `sandbox snapshot header is format ${header.format}, ${
        header.store === undefined ? "without" : "with"
      } a store`;
    }
    if (header.store !== undefined) {
      try {
        parseStorePin(header.store, (what) => {
          throw new Error(what);
        });
      } catch (error) {
        return `sandbox snapshot header's ${(error as Error).message}`;
      }
    }
  }
  return buildMismatch(header.builtFrom, expected);
}

/** Hand the next `bytes` bytes of the body -- `rest` first, then from
 * `reader` -- to `take`, in order; what was read past them comes back. */
async function readSection(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  rest: Uint8Array,
  bytes: number,
  what: string,
  take: (chunk: Uint8Array, offset: number) => void | Promise<void>,
): Promise<Uint8Array> {
  let had = 0;
  for (let chunk = rest;;) {
    const wanted = bytes - had;
    if (chunk.byteLength >= wanted) {
      if (wanted > 0) await take(chunk.subarray(0, wanted), had);
      return chunk.subarray(wanted);
    }
    if (chunk.byteLength > 0) await take(chunk, had);
    had += chunk.byteLength;
    const { done, value } = await reader.read();
    if (done) {
      throw new Error(
        `sandbox snapshot is truncated (${had} of ${bytes} bytes${what})`,
      );
    }
    chunk = value;
  }
}

/** Write a format-4 file's store into `target`, from the body after its
 * header: the lower from the image first, then each exported file in
 * order, then the copy completed and the identity it replays to checked.
 * Their bytes were checked part by part as they downloaded
 * (fetchVerifiedSnapshot); each file's sha256 is not hashed again here,
 * which would hold the whole file at once, and the kernel's replay checks
 * the files themselves. Returns what was read past the store. */
async function restoreStore(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  rest: Uint8Array,
  store: StorePin,
  target: StoreRestoreTarget,
  image: () => Promise<Uint8Array>,
): Promise<Uint8Array> {
  const lower = await target.materializeLower(await image());
  if (
    lower.bytes !== store.lower.bytes || lower.sha256 !== store.lower.sha256
  ) {
    throw new SnapshotMismatch(
      `the image materializes to a lower.tar of ${lower.bytes} bytes, sha256 ${lower.sha256}; ` +
        `the snapshot's store was made over ${store.lower.bytes} bytes, sha256 ${store.lower.sha256}`,
    );
  }
  for (const file of store.files) {
    rest = await readSection(
      reader,
      rest,
      file.bytes,
      ` of the store's ${file.name}`,
      (chunk, offset) => target.write(file.name, offset, chunk),
    );
  }
  const why = identityMismatch(await target.complete(), store.identity);
  if (why !== undefined) {
    throw new SnapshotMismatch(`restoring the snapshot's store: ${why}`);
  }
  return rest;
}

/** A snapshot file's (gzipped) header: what it was built from, read
 * without its memory. Throws {@link SnapshotMismatch} when that is not
 * `expected` (every field it has). */
export async function checkSandboxSnapshot(
  body: ReadableStream<Uint8Array<ArrayBuffer>>,
  expected: SnapshotIdentity | BuiltFrom,
  /** As for {@link headerMismatch}: undefined takes either format. */
  rootStore?: boolean,
): Promise<BuiltFrom> {
  const reader = body.pipeThrough(new DecompressionStream("gzip"))
    .getReader();
  try {
    const { header } = await readHeader(reader);
    const why = headerMismatch(header, expected, rootStore);
    if (why !== undefined) {
      throw new SnapshotMismatch(why);
    }
    return header.builtFrom!;
  } finally {
    await reader.cancel().catch(() => {});
  }
}

/** A snapshot file's header facts for its pin: its format, its kernel
 * memory, what it holds (undefined in an older capture) and its store (in
 * format 4). Reads no memory. */
export async function snapshotHeaderFacts(
  body: ReadableStream<Uint8Array<ArrayBuffer>>,
): Promise<{
  format: number;
  memoryBytes: number;
  contents?: SnapshotContents;
  store?: StorePin;
}> {
  const reader = body.pipeThrough(new DecompressionStream("gzip"))
    .getReader();
  try {
    const { header } = await readHeader(reader);
    if (!Number.isInteger(header.memoryBytes)) {
      throw new Error("sandbox snapshot header names no memoryBytes");
    }
    if (!Number.isInteger(header.format)) {
      throw new Error("sandbox snapshot header names no format");
    }
    return {
      format: header.format!,
      memoryBytes: header.memoryBytes!,
      ...(header.contents === undefined ? {} : { contents: header.contents }),
      ...(header.store === undefined ? {} : {
        // As a pin holds it, so the two compare as written.
        store: parseStorePin(header.store, (what) => {
          throw new Error(`sandbox snapshot header's ${what}`);
        }),
      }),
    };
  } finally {
    await reader.cancel().catch(() => {});
  }
}

/** Read a snapshot file's (gzipped) body back into a seal image. A
 * snapshot not built from `expected` is refused as soon as its header is
 * read, before its memory (over 500 MiB) is allocated. With `store` (the
 * kernel's root is a YurtFS store) only format 4 is taken: its store goes
 * into `store.target` first, and a store that is not `store.expect` --
 * in the header, or as the written copy replays -- is refused before the
 * memory is allocated. Without it only format 3 is taken. */
export async function decodeSandboxSnapshot(
  body: ReadableStream<Uint8Array<ArrayBuffer>>,
  expected: SnapshotIdentity | BuiltFrom,
  /** Told what the header says the snapshot was built from, once it is
   * accepted. */
  onHeader?: (builtFrom: BuiltFrom) => void,
  /** Awaited after the header is accepted and before the memory is
   * allocated: a check that may still refuse the snapshot (the live
   * index's) refuses it before the ~250-545 MiB exist. */
  beforeAllocate?: () => Promise<void>,
  store?: {
    /** The fresh store to write; the caller discards it on a throw. */
    target: StoreRestoreTarget;
    /** The pin's store identity. */
    expect: StoreIdentity;
    /** The image the store's lower is materialized from. */
    image: () => Promise<Uint8Array>;
  },
): Promise<SandboxSealImage> {
  // A reader, not `for await`: WebKit's ReadableStream is not async-iterable.
  const reader = body.pipeThrough(new DecompressionStream("gzip"))
    .getReader();
  try {
    let { header, rest } = await readHeader(reader);
    const why = headerMismatch(header, expected, store !== undefined);
    if (why !== undefined) throw new SnapshotMismatch(why);
    if (store !== undefined) {
      const pinned = identityMismatch(header.store!.identity, store.expect);
      if (pinned !== undefined) {
        throw new SnapshotMismatch(`the snapshot's header says ${pinned}`);
      }
    }
    onHeader?.(header.builtFrom!);
    await beforeAllocate?.();
    if (store !== undefined) {
      rest = await restoreStore(
        reader,
        rest,
        header.store!,
        store.target,
        store.image,
      );
    }
    const {
      format: _format,
      builtFrom: _builtFrom,
      memoryBytes,
      contents: _contents,
      store: _store,
      ...seal
    } = header as Header;
    const memory = new Uint8Array(memoryBytes);
    rest = await readSection(
      reader,
      rest,
      memoryBytes,
      "",
      (chunk, offset) => memory.set(chunk, offset),
    );
    for (;;) {
      if (rest.byteLength > 0) {
        throw new Error("sandbox snapshot is longer than its header says");
      }
      const { done, value } = await reader.read();
      if (done) break;
      rest = value;
    }
    return { ...seal, kernelMemory: memory, processes: [] };
  } catch (error) {
    // Whatever is still downloading stops: the source is cancelled.
    await reader.cancel(error).catch(() => {});
    throw error;
  }
}

/** The Cache API store that keeps a snapshot's checked parts between
 * visits, each under its own sha256: a repeat visit downloads nothing. */
export const SNAPSHOT_PARTS_CACHE = "yurt-playground-snapshot-parts-v1";
const PART_KEY_ORIGIN = "https://yurt-snapshot-parts.invalid/";

/** How many parts are downloaded at once: each is held whole for its
 * check (20 MiB), so a few, not all of them. */
export const SNAPSHOT_PARTS_IN_FLIGHT = 3;

/** The snapshot file at `path`, in the parts the site publishes, each
 * checked against the pin's sha256 for it as it arrives: a stream for
 * {@link decodeSandboxSnapshot} that errors on the first part that is not
 * the pinned one. Part by part, not the whole file: holding all of it to
 * hash it at once was more than a Safari tab survives. Up to
 * {@link SNAPSHOT_PARTS_IN_FLIGHT} parts download at once, and the stream
 * gives them in order. With `cache`, a checked part is kept there under
 * its sha256 and taken from there next time (checked again); once every
 * part is had, parts of any other snapshot are dropped from it. */
export async function fetchVerifiedSnapshot(
  path: string,
  pin: SnapshotPin,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  /** Bytes checked so far, of the whole file's. */
  onProgress?: (loaded: number, total: number) => void,
  cache?: CacheStorage,
): Promise<ReadableStream<Uint8Array<ArrayBuffer>>> {
  const base = typeof location === "undefined" ? undefined : location.href;
  const manifestUrl = new URL(`${path}.parts.json`, base);
  const manifestResponse = await fetchImpl(manifestUrl);
  if (!manifestResponse.ok) {
    throw new Error(
      `fetch ${path}.parts.json failed: ${manifestResponse.status}`,
    );
  }
  const manifest = await manifestResponse.json() as {
    size: number;
    parts: string[];
  };
  if (
    manifest.size !== pin.size ||
    manifest.parts.length !== pin.parts.length
  ) {
    throw new Error(
      `${path} is published as ${manifest.size} bytes in ${manifest.parts.length} parts, ` +
        `not the pinned ${pin.size} in ${pin.parts.length}`,
    );
  }
  const store = cache === undefined
    ? undefined
    : await cache.open(SNAPSHOT_PARTS_CACHE).catch(() => undefined);
  const giveUp = new AbortController();
  const keyOf = (sha256: string) => `${PART_KEY_ORIGIN}${sha256}`;
  /** Part `at`, checked: from the cache when it holds it, else fetched
   * (and then kept). */
  const part = async (at: number): Promise<Uint8Array<ArrayBuffer>> => {
    const want = pin.parts[at];
    const cached = await store?.match(keyOf(want)).catch(() => undefined);
    if (cached !== undefined) {
      const bytes = new Uint8Array(await cached.arrayBuffer());
      if (await sha256Hex(bytes) === want) return bytes;
      // A damaged entry is fetched again, never used.
      await store?.delete(keyOf(want)).catch(() => {});
    }
    const name = manifest.parts[at];
    const response = await fetchImpl(new URL(name, manifestUrl), {
      signal: giveUp.signal,
    });
    if (!response.ok) {
      throw new Error(`fetch ${name} failed: ${response.status}`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    const actual = await sha256Hex(bytes);
    if (actual !== want) {
      throw new Error(
        `sandbox snapshot part ${name} sha256 mismatch: got ${actual}, pinned ${want}`,
      );
    }
    await store?.put(keyOf(want), new Response(bytes)).catch(() => {});
    return bytes;
  };
  const pending: Promise<Uint8Array<ArrayBuffer>>[] = [];
  let asked = 0;
  const askMore = () => {
    while (
      asked < pin.parts.length && pending.length < SNAPSHOT_PARTS_IN_FLIGHT
    ) {
      const next = part(asked++);
      next.catch(() => {});
      pending.push(next);
    }
  };
  let loaded = 0;
  return new ReadableStream<Uint8Array<ArrayBuffer>>({
    start() {
      askMore();
    },
    async pull(controller) {
      const next = pending.shift();
      if (next === undefined) {
        controller.close();
        // Every part is had: parts of other snapshots go.
        if (store !== undefined) {
          const keep = new Set(pin.parts.map(keyOf));
          for (const request of await store.keys().catch(() => [])) {
            if (!keep.has(request.url)) {
              await store.delete(request).catch(() => {});
            }
          }
        }
        return;
      }
      let bytes: Uint8Array<ArrayBuffer>;
      try {
        bytes = await next;
      } catch (error) {
        giveUp.abort(error);
        throw error;
      }
      askMore();
      loaded += bytes.byteLength;
      onProgress?.(loaded, pin.size);
      controller.enqueue(bytes);
    },
    cancel(reason) {
      giveUp.abort(reason);
    },
  });
}
