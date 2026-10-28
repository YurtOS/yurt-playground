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
 * Bigints in the header are written as `{"$bigint": "<decimal>"}`.
 */
import type { SandboxSealImage } from "@yurt/kernel-host-interface-js";

/** Where the page fetches the snapshot (in parts, src/image_parts.ts). */
export const SANDBOX_SNAPSHOT_NAME = "snapshot/sandbox.seal.gz";
export const SANDBOX_SNAPSHOT_PATH = `./${SANDBOX_SNAPSHOT_NAME}`;

type Header = Omit<SandboxSealImage, "kernelMemory" | "processes"> & {
  /** The kernel build the image was sealed under; a restore needs the same. */
  kernelSha256: string;
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
  kernelSha256: string,
): Promise<Blob> {
  if (image.processes.length !== 0) {
    throw new Error(
      `a sandbox snapshot holds no process; this seal has ${image.processes.length}`,
    );
  }
  const { kernelMemory, processes: _processes, ...rest } = image;
  const header: Header = {
    ...rest,
    kernelSha256,
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

/** Read a snapshot file's (gzipped) body back into a seal image. */
export async function decodeSandboxSnapshot(
  body: ReadableStream<Uint8Array<ArrayBuffer>>,
): Promise<{ image: SandboxSealImage; kernelSha256: string }> {
  // A reader, not `for await`: WebKit's ReadableStream is not async-iterable.
  const reader = body.pipeThrough(new DecompressionStream("gzip"))
    .getReader();
  let pending = new Uint8Array(0);
  let header: Header | undefined;
  let memory: Uint8Array | undefined;
  let filled = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    let chunk = value;
    if (header === undefined) {
      const joined = new Uint8Array(pending.byteLength + chunk.byteLength);
      joined.set(pending);
      joined.set(chunk, pending.byteLength);
      if (joined.byteLength < 4) {
        pending = joined;
        continue;
      }
      const length = new DataView(joined.buffer).getUint32(0, true);
      if (joined.byteLength < 4 + length) {
        pending = joined;
        continue;
      }
      header = JSON.parse(
        new TextDecoder().decode(joined.subarray(4, 4 + length)),
        reviver,
      ) as Header;
      memory = new Uint8Array(header.memoryBytes);
      chunk = joined.subarray(4 + length);
      pending = new Uint8Array(0);
    }
    if (filled + chunk.byteLength > memory!.byteLength) {
      throw new Error("sandbox snapshot is longer than its header says");
    }
    memory!.set(chunk, filled);
    filled += chunk.byteLength;
  }
  if (header === undefined || filled !== header.memoryBytes) {
    throw new Error(
      `sandbox snapshot is truncated (${filled} of ${header?.memoryBytes} bytes)`,
    );
  }
  const { kernelSha256, memoryBytes: _memoryBytes, ...rest } = header;
  return {
    image: { ...rest, kernelMemory: memory!, processes: [] },
    kernelSha256,
  };
}
