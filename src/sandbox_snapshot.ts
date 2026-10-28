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
import { partsFetch } from "./image_parts.ts";
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
/** The seal image version this page's host writes and restores; typed by
 * the host's own, so a host with another version fails the type check
 * until this follows it. */
export const SEAL_VERSION: SandboxSealImage["version"] = 1;

/** The page's boot setup, as a snapshot records it: bump it when
 * src/boot.ts changes what a boot stages beside the image or how it sets
 * up the login user, so a snapshot made the old way is not restored. */
export const BOOT_SETUP = 1;

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

/** The site's pinned snapshot, when the entry is well formed and was
 * built from the site's own pins: what `?snapshot=1` may download. */
export function pinnedSnapshot(pins: Pins): SnapshotPin {
  if (pins.snapshot === undefined) {
    throw new SnapshotMismatch("the site pins no sandbox snapshot");
  }
  let pin: SnapshotPin;
  try {
    pin = parseSnapshotPin(pins.snapshot);
  } catch (error) {
    throw new SnapshotMismatch(
      `the pinned snapshot entry is malformed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (pin.format !== FORMAT) {
    throw new SnapshotMismatch(
      `the pinned snapshot is format ${pin.format}, not ${FORMAT}`,
    );
  }
  const why = mismatch(pin.builtFrom, snapshotIdentity(pins));
  if (why !== undefined) {
    throw new SnapshotMismatch(`pinned ${why.replace(/^sandbox /, "")}`);
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
  if (live !== undefined && live !== builtFrom.pythonSet) {
    throw new SnapshotMismatch(
      `the snapshot's Python set is ${builtFrom.pythonSet}, the live index offers ${live}`,
    );
  }
}

/** The header's format: 2 added `builtFrom`, 3 its `pythonSet`. */
export const FORMAT = 3;

type Header = Omit<SandboxSealImage, "kernelMemory" | "processes"> & {
  format: number;
  builtFrom: BuiltFrom;
  memoryBytes: number;
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

/** The snapshot file at `path`, in the parts the site publishes, each
 * checked against the pin's sha256 for it as it arrives: a stream for
 * {@link decodeSandboxSnapshot} that errors on the first part that is not
 * the pinned one. Part by part, not the whole file: holding all of it to
 * hash it at once was more than a Safari tab survives. */
export async function fetchVerifiedSnapshot(
  path: string,
  pin: SnapshotPin,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  /** Bytes checked so far, of the whole file's. */
  onProgress?: (loaded: number, total: number) => void,
): Promise<ReadableStream<Uint8Array<ArrayBuffer>>> {
  let loaded = 0;
  const response = await partsFetch(fetchImpl, {
    manifest(manifest) {
      if (
        manifest.size !== pin.size ||
        manifest.parts.length !== pin.parts.length
      ) {
        throw new Error(
          `${path} is published as ${manifest.size} bytes in ${manifest.parts.length} parts, ` +
            `not the pinned ${pin.size} in ${pin.parts.length}`,
        );
      }
    },
    async part(index, name, bytes) {
      const actual = await sha256Hex(bytes);
      if (actual !== pin.parts[index]) {
        throw new Error(
          `sandbox snapshot part ${name} sha256 mismatch: got ${actual}, pinned ${
            pin.parts[index]
          }`,
        );
      }
      loaded += bytes.byteLength;
      onProgress?.(loaded, pin.size);
    },
  })(path);
  if (!response.ok || response.body === null) {
    throw new Error(`fetch ${path}.parts.json failed: ${response.status}`);
  }
  return response.body as ReadableStream<Uint8Array<ArrayBuffer>>;
}
