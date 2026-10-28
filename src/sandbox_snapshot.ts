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
 * Beside the file, `<file>.sha256` holds the file's hash for the page to
 * check what it downloaded against.
 */
import type { SandboxSealImage } from "@yurt/kernel-host-interface-js";
import { partsFetch } from "./image_parts.ts";
import { sha256Hex } from "./integrity.ts";
import type { Pins } from "./pins.ts";

/** Where the page fetches the snapshot (in parts, src/image_parts.ts). */
export const SANDBOX_SNAPSHOT_NAME = "snapshot/sandbox.seal.gz";
export const SANDBOX_SNAPSHOT_PATH = `./${SANDBOX_SNAPSHOT_NAME}`;
/** The snapshot file's sha256, lowercase hex, written by the static build
 * (and the dev server) next to the file. */
export const SANDBOX_SNAPSHOT_SHA256_NAME = `${SANDBOX_SNAPSHOT_NAME}.sha256`;

/** What a snapshot was built from: a restore needs the same of all three.
 * The kernel must match its own memory layout; the image and the Python
 * set are what the sandbox's files came from, so a site that moved to
 * another train must not hand out the last one's files. */
export type SnapshotIdentity = {
  /** The kernel build the image was sealed under. */
  kernelSha256: string;
  /** The image the sandbox booted (the slim one, when the pins name it). */
  imageSha256: string;
  /** The train's Python set, by its sealable CPython's hash (`pythonSeal`
   * in the pins); null on a site that pins none. */
  pythonSealSha256: string | null;
};

/** The identity a snapshot made under `pins` records, and a restore under
 * them requires. */
export function snapshotIdentity(
  pins: Pick<Pins, "kernelWasm" | "image" | "browserImage" | "pythonSeal">,
): SnapshotIdentity {
  return {
    kernelSha256: pins.kernelWasm.sha256,
    imageSha256: (pins.browserImage ?? pins.image).sha256,
    pythonSealSha256: pins.pythonSeal?.sha256 ?? null,
  };
}

/** A snapshot built from something else than this site's pins (or one in
 * an older format that does not say). Nothing of its memory was read. */
export class SnapshotMismatch extends Error {}

/** The header's format: 2 added `builtFrom`. */
const FORMAT = 2;

type Header = Omit<SandboxSealImage, "kernelMemory" | "processes"> & {
  format: number;
  builtFrom: SnapshotIdentity;
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
  builtFrom: SnapshotIdentity,
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

/** Why a snapshot's `builtFrom` is not `expected`, or undefined when it
 * is the same build. */
function mismatch(
  builtFrom: SnapshotIdentity | undefined,
  expected: SnapshotIdentity,
): string | undefined {
  if (builtFrom === undefined) {
    return "sandbox snapshot does not say what it was built from (an older format)";
  }
  const differs = (Object.keys(expected) as (keyof SnapshotIdentity)[])
    .filter((key) => builtFrom[key] !== expected[key])
    .map((key) => `${key} ${builtFrom[key]}, not ${expected[key]}`);
  return differs.length === 0
    ? undefined
    : `sandbox snapshot was built from ${differs.join("; ")}`;
}

/** A snapshot file's (gzipped) header: what it was built from, read
 * without its memory. Throws {@link SnapshotMismatch} when that is not
 * `expected`. */
export async function checkSandboxSnapshot(
  body: ReadableStream<Uint8Array<ArrayBuffer>>,
  expected: SnapshotIdentity,
): Promise<void> {
  const reader = body.pipeThrough(new DecompressionStream("gzip"))
    .getReader();
  try {
    const { header } = await readHeader(reader);
    const why = mismatch(header.builtFrom, expected);
    if (why !== undefined) {
      throw new SnapshotMismatch(why);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

/** Read a snapshot file's (gzipped) body back into a seal image. A
 * snapshot not built from `expected` is refused as soon as its header is
 * read, before its memory (over 500 MiB) is allocated. */
export async function decodeSandboxSnapshot(
  body: ReadableStream<Uint8Array<ArrayBuffer>>,
  expected: SnapshotIdentity,
): Promise<SandboxSealImage> {
  // A reader, not `for await`: WebKit's ReadableStream is not async-iterable.
  const reader = body.pipeThrough(new DecompressionStream("gzip"))
    .getReader();
  const { header, rest } = await readHeader(reader);
  const why = mismatch(header.builtFrom, expected);
  if (why !== undefined) {
    await reader.cancel().catch(() => {});
    throw new SnapshotMismatch(why);
  }
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
}

/** The snapshot file at `path` (published in parts), checked against the
 * sha256 published beside it, as a stream for
 * {@link decodeSandboxSnapshot}. The hash is the site's own, like the page
 * that checks it: what it catches is a download that is not the file the
 * build published -- cut short, damaged, or parts of two builds. */
export async function fetchVerifiedSnapshot(
  path: string,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<ReadableStream<Uint8Array<ArrayBuffer>>> {
  const sidecar = await fetchImpl(`${path}.sha256`);
  if (!sidecar.ok) {
    throw new Error(`fetch ${path}.sha256 failed: ${sidecar.status}`);
  }
  const expected = (await sidecar.text()).trim().toLowerCase();
  const response = await partsFetch(fetchImpl)(path);
  if (!response.ok) throw new Error(`fetch ${path} failed: ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const actual = await sha256Hex(bytes);
  if (actual !== expected) {
    throw new Error(
      `sandbox snapshot sha256 mismatch: got ${actual}, published ${expected}`,
    );
  }
  // In slices, not one chunk: decoding inflates as it goes.
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.byteLength) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.subarray(offset, offset += 1 << 20));
    },
  });
}
