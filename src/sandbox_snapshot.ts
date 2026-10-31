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
 * The file is published as a yurt-playground release by
 * scripts/release-snapshot.ts, pinned in artifacts/pins.json (`snapshot`:
 * its parts' sha256s and what it was built from), fetched into the site by
 * scripts/install-pinned-artifacts.sh, and checked part by part as the page
 * downloads it.
 */
import type { SandboxSealImage } from "@yurt/kernel-host-interface-js";
import { sha256Hex } from "./integrity.ts";
import type { BuiltFrom, SnapshotIdentity, SnapshotPin } from "./pins.ts";
import {
  buildMismatch,
  FORMAT,
  SEAL_VERSION,
  type SnapshotContents,
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

/** The snapshot file for `image`, a seal with no process in it. */
export async function encodeSandboxSnapshot(
  image: SandboxSealImage,
  builtFrom: BuiltFrom,
  contents?: SnapshotContents,
): Promise<Blob> {
  if (image.processes.length !== 0) {
    throw new Error(
      `a sandbox snapshot holds no process; this seal has ${image.processes.length}`,
    );
  }
  const { kernelMemory, processes: _processes, ...rest } = image;
  const header: Header = {
    ...rest,
    format: FORMAT,
    builtFrom,
    memoryBytes: kernelMemory.byteLength,
    ...(contents === undefined ? {} : { contents }),
  };
  const json = new TextEncoder().encode(JSON.stringify(header, replacer));
  const length = new Uint8Array(4);
  new DataView(length.buffer).setUint32(0, json.byteLength, true);
  // The seal copied the memory out (`slice`), so its buffer is plain.
  const raw = new Blob([length, json, kernelMemory as Uint8Array<ArrayBuffer>]);
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
 * another format, or another build. */
function headerMismatch(
  header: Partial<Header>,
  expected: SnapshotIdentity | BuiltFrom,
): string | undefined {
  if (header.builtFrom !== undefined && header.format !== FORMAT) {
    return `sandbox snapshot header is format ${header.format}, not ${FORMAT}`;
  }
  return buildMismatch(header.builtFrom, expected);
}

/** A snapshot file's (gzipped) header: what it was built from, read
 * without its memory. Throws {@link SnapshotMismatch} when that is not
 * `expected` (every field it has). */
export async function checkSandboxSnapshot(
  body: ReadableStream<Uint8Array<ArrayBuffer>>,
  expected: SnapshotIdentity | BuiltFrom,
): Promise<BuiltFrom> {
  const reader = body.pipeThrough(new DecompressionStream("gzip"))
    .getReader();
  try {
    const { header } = await readHeader(reader);
    const why = headerMismatch(header, expected);
    if (why !== undefined) {
      throw new SnapshotMismatch(why);
    }
    return header.builtFrom!;
  } finally {
    await reader.cancel().catch(() => {});
  }
}

/** A snapshot file's header facts for its pin: its kernel memory and
 * what it holds (undefined in an older capture). Reads no memory. */
export async function snapshotHeaderFacts(
  body: ReadableStream<Uint8Array<ArrayBuffer>>,
): Promise<{ memoryBytes: number; contents?: SnapshotContents }> {
  const reader = body.pipeThrough(new DecompressionStream("gzip"))
    .getReader();
  try {
    const { header } = await readHeader(reader);
    if (!Number.isInteger(header.memoryBytes)) {
      throw new Error("sandbox snapshot header names no memoryBytes");
    }
    return {
      memoryBytes: header.memoryBytes!,
      ...(header.contents === undefined ? {} : { contents: header.contents }),
    };
  } finally {
    await reader.cancel().catch(() => {});
  }
}

/** Read a snapshot file's (gzipped) body back into a seal image. A
 * snapshot not built from `expected` is refused as soon as its header is
 * read, before its memory (over 500 MiB) is allocated. */
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
): Promise<SandboxSealImage> {
  // A reader, not `for await`: WebKit's ReadableStream is not async-iterable.
  const reader = body.pipeThrough(new DecompressionStream("gzip"))
    .getReader();
  try {
    const { header, rest } = await readHeader(reader);
    const why = headerMismatch(header, expected);
    if (why !== undefined) throw new SnapshotMismatch(why);
    onHeader?.(header.builtFrom!);
    await beforeAllocate?.();
    const {
      format: _format,
      builtFrom: _builtFrom,
      memoryBytes,
      contents: _contents,
      ...seal
    } = header as Header;
    const memory = new Uint8Array(memoryBytes);
    let filled = 0;
    for (let chunk = rest;;) {
      if (filled + chunk.byteLength > memory.byteLength) {
        throw new Error("sandbox snapshot is longer than its header says");
      }
      memory.set(chunk, filled);
      filled += chunk.byteLength;
      const { done, value } = await reader.read();
      if (done) break;
      chunk = value;
    }
    if (filled !== memoryBytes) {
      throw new Error(
        `sandbox snapshot is truncated (${filled} of ${memoryBytes} bytes)`,
      );
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
