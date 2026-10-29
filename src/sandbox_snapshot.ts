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
import {
  type BuiltFrom,
  parseSnapshotPin,
  type Pins,
  type SnapshotIdentity,
  type SnapshotPin,
} from "./pins.ts";

export type { BuiltFrom, SnapshotIdentity, SnapshotPin };

/** Where the page fetches the snapshot (in parts, src/image_parts.ts). */
export const SANDBOX_SNAPSHOT_NAME = "snapshot/sandbox.seal.gz";
export const SANDBOX_SNAPSHOT_PATH = `./${SANDBOX_SNAPSHOT_NAME}`;

/**
 * Which snapshot a device restores by default (until a boot of the slim
 * image fits a phone again): a desktop the full one, with the Python set
 * and Jupyter; a tablet the slim image as it boots, its own python3 and no
 * set; a phone the same image with python taken out. Each has its own
 * pins.json entry, file, capture mode and release tag; the checks are the
 * same. A phone's or tablet's page asks for no Python set, so it restores
 * only a snapshot without one (checkPythonSet).
 */
export type SnapshotKind = "desktop" | "tablet" | "phone";

export const SNAPSHOT_KINDS: Record<SnapshotKind, {
  /** Its artifacts/pins.json entry. */
  pinKey: "snapshot" | "tabletSnapshot" | "phoneSnapshot";
  /** Its file in the site, published in parts. */
  name: string;
  /** The release asset (the name's last part). */
  asset: string;
  /** `?snapshot=<capture>` makes it. */
  capture: "capture" | "capture-tablet" | "capture-phone";
  /** Its release tag, before the train. */
  tagPrefix: string;
}> = {
  desktop: {
    pinKey: "snapshot",
    name: SANDBOX_SNAPSHOT_NAME,
    asset: "sandbox.seal.gz",
    capture: "capture",
    tagPrefix: "snapshot-",
  },
  tablet: {
    pinKey: "tabletSnapshot",
    name: "snapshot/tablet.seal.gz",
    asset: "tablet.seal.gz",
    capture: "capture-tablet",
    tagPrefix: "snapshot-tablet-",
  },
  phone: {
    pinKey: "phoneSnapshot",
    name: "snapshot/phone.seal.gz",
    asset: "phone.seal.gz",
    capture: "capture-phone",
    tagPrefix: "snapshot-phone-",
  },
};

export const SNAPSHOT_KIND_NAMES = Object.keys(
  SNAPSHOT_KINDS,
) as SnapshotKind[];

/** The kind `?snapshot=<value>` captures, or undefined. */
export function captureKindOf(
  value: string | null,
): SnapshotKind | undefined {
  return SNAPSHOT_KIND_NAMES.find((kind) =>
    SNAPSHOT_KINDS[kind].capture === value
  );
}

/** The tablet snapshot's Python: the interpreter alone, installed with
 * pkg on the slim image (no numpy, pyzmq or Jupyter kernel: a tablet runs
 * no Jupyter). Its capture installs it, and its restore asks the live
 * index about it, keyed like the full set (a layer key). */
export const TABLET_PYTHON_SET: readonly string[] = ["python"];

export function tabletPythonRequest(
  pins: Pick<Pins, "browserImage">,
): { label: string; set: string[]; image: string } | undefined {
  return pins.browserImage === undefined ? undefined : {
    label: "Python",
    set: [...TABLET_PYTHON_SET],
    image: pins.browserImage.sha256,
  };
}

/** What a snapshot holds, recorded at capture: pkg's installed list and
 * one line for people (src/linux_remark.ts). */
export type SnapshotContents = {
  packages: { name: string; version: string; build: string }[];
  remark: string;
};
/** The seal image version this page's host writes and restores; typed by
 * the host's own, so a host with another version fails the type check
 * until this follows it. */
export const SEAL_VERSION: SandboxSealImage["version"] = 1;

/** The page's boot setup, as a snapshot records it: bump it when
 * src/boot.ts changes what a boot stages beside the image or how it sets
 * up the login user, so a snapshot made the old way is not restored.
 * 2: /etc/motd holds this Linux's remark (src/linux_remark.ts). */
export const BOOT_SETUP = 2;

/** The identity a snapshot made under `pins` records, and a restore under
 * them requires. */
export function snapshotIdentity(
  pins: Pick<Pins, "kernelWasm" | "image" | "browserImage" | "pythonSeal">,
): SnapshotIdentity {
  return {
    kernelSha256: pins.kernelWasm.sha256,
    kernelRev: pins.kernelWasm.rev,
    sealVersion: SEAL_VERSION,
    bootSetup: BOOT_SETUP,
    imageSha256: (pins.browserImage ?? pins.image).sha256,
    pythonSealSha256: pins.pythonSeal?.sha256 ?? null,
  };
}

/** A snapshot built from something else than this site's pins (or one in
 * an older format that does not say, or none pinned at all). Nothing of
 * its memory was read. */
export class SnapshotMismatch extends Error {}

/** The site's pinned snapshot of `kind`, when the entry is well formed
 * and was built from the site's own pins: what a restore may download. */
export function pinnedSnapshot(
  pins: Pins,
  kind: SnapshotKind = "desktop",
): SnapshotPin {
  const entry = pins[SNAPSHOT_KINDS[kind].pinKey];
  if (entry === undefined) {
    throw new SnapshotMismatch(
      kind === "desktop"
        ? "the site pins no sandbox snapshot"
        : `the site pins no ${kind} snapshot (${SNAPSHOT_KINDS[kind].pinKey})`,
    );
  }
  return acceptedSnapshot(entry, pins);
}

/** A snapshot entry (the pin's shape: `?snapshot=1`'s pin, or an uploaded
 * snapshot's manifest, src/snapshot_source.ts) when it is well formed, of
 * this page's format and built from `pins`; else {@link SnapshotMismatch},
 * its message starting with `what`. */
export function acceptedSnapshot(
  entry: unknown,
  pins: Pins,
  what = "pinned snapshot",
): SnapshotPin {
  let pin: SnapshotPin;
  try {
    pin = parseSnapshotPin(entry);
  } catch (error) {
    throw new SnapshotMismatch(
      `the ${what} entry is malformed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (pin.format !== FORMAT) {
    throw new SnapshotMismatch(
      `the ${what} is format ${pin.format}, not ${FORMAT}`,
    );
  }
  const why = mismatch(pin.builtFrom, snapshotIdentity(pins));
  if (why !== undefined) {
    throw new SnapshotMismatch(
      `${what} ${why.replace(/^sandbox snapshot /, "")}`,
    );
  }
  return pin;
}

/** Refuses a snapshot whose Python set is not the one the live index
 * offers now (`live`, a layer key as liveLayerKey makes it): installing
 * would give another set, so restoring this one would not be the same.
 * `live` undefined -- the index could not be asked -- takes the snapshot,
 * as a stored layer is used offline. */
export function checkPythonSet(
  builtFrom: BuiltFrom,
  live: string | null | undefined,
): void {
  if (live === undefined || live === builtFrom.pythonSet) return;
  throw new SnapshotMismatch(
    live === null
      // No request at all, the index not asked: a phone, a shell-only
      // session, or a page without its pins.
      ? `this page installs no Python (a phone, a shell-only session, or no pins), and the snapshot holds ${builtFrom.pythonSet}`
      : builtFrom.pythonSet === null
      ? `the snapshot holds no Python set, the live index offers ${live}`
      : `the snapshot's Python set is ${builtFrom.pythonSet}, the live index offers ${live}`,
  );
}

/** The header's format: 2 added `builtFrom`, 3 its `pythonSet`. */
export const FORMAT = 3;

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

/** Why a snapshot's `builtFrom` is not `expected` (every field `expected`
 * has), or undefined when it is the same build. */
function mismatch(
  builtFrom: Partial<BuiltFrom> | undefined,
  expected: SnapshotIdentity | BuiltFrom,
): string | undefined {
  if (builtFrom === undefined) {
    return "sandbox snapshot does not say what it was built from (an older format)";
  }
  const want = expected as Partial<BuiltFrom>;
  const differs = (Object.keys(want) as (keyof BuiltFrom)[])
    .filter((key) => builtFrom[key] !== want[key])
    .map((key) => `${key} ${builtFrom[key]}, not ${want[key]}`);
  return differs.length === 0
    ? undefined
    : `sandbox snapshot was built from ${differs.join("; ")}`;
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
  return mismatch(header.builtFrom, expected);
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
): Promise<SandboxSealImage> {
  // A reader, not `for await`: WebKit's ReadableStream is not async-iterable.
  const reader = body.pipeThrough(new DecompressionStream("gzip"))
    .getReader();
  try {
    const { header, rest } = await readHeader(reader);
    const why = headerMismatch(header, expected);
    if (why !== undefined) throw new SnapshotMismatch(why);
    onHeader?.(header.builtFrom!);
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
