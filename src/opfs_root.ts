import {
  type SyncAccessHandleLike,
  SyncHandleYurtDevice,
} from "@yurt/kernel-host-interface-js";
import { Decompress } from "fzstd";

/**
 * The guest's root filesystem in OPFS (yurtos-kernel#3081), instead of in
 * the kernel's memory. The decompressed image is written into OPFS once per
 * image (keyed by its sha256, reused by every later boot), each tab gets a
 * fresh file for what its guest writes, and a `SyncHandleYurtDevice` serves
 * both through synchronous access handles opened here, before the mount:
 * nothing the kernel calls afterwards waits on a promise.
 *
 * Only the subset of the OPFS API this uses is typed, so tests can hand in
 * a directory of their own.
 */
export interface OpfsFile {
  createSyncAccessHandle(
    options?: { mode?: "read-only" | "readwrite" },
  ): Promise<SyncAccessHandleLike>;
}

export interface OpfsDirectory {
  getDirectoryHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<OpfsDirectory>;
  getFileHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<OpfsFile>;
  removeEntry(name: string): Promise<void>;
  keys(): AsyncIterable<string>;
}

export type GuestRoot =
  | {
    kind: "device";
    device: SyncHandleYurtDevice;
    /** Whether this boot wrote the image (the first boot of this image). */
    wroteImage: boolean;
  }
  | { kind: "memory"; reason: string };

/** OPFS as this worker sees it, or undefined where there is none (Deno,
 * the main thread of a page, a private window that refuses storage). */
export async function browserStorageRoot(): Promise<OpfsDirectory | undefined> {
  const storage = (globalThis.navigator as { storage?: StorageManager })
    ?.storage;
  if (typeof storage?.getDirectory !== "function") return undefined;
  // Sync access handles exist only in dedicated workers.
  const fileHandle =
    (globalThis as { FileSystemFileHandle?: { prototype: object } })
      .FileSystemFileHandle;
  if (!fileHandle || !("createSyncAccessHandle" in fileHandle.prototype)) {
    return undefined;
  }
  try {
    return await storage.getDirectory() as unknown as OpfsDirectory;
  } catch {
    return undefined;
  }
}

const DIRECTORY = "yurt-fs";
const INPUT_SLICE = 1 << 20;

/**
 * Open the guest's root on OPFS. Every failure is a reason to stage into
 * memory instead, never a failed boot: a missing API, a refused quota, or
 * the image held by another tab (Safari's sync handles are exclusive).
 */
export async function openGuestRoot(options: {
  storage: OpfsDirectory | undefined;
  imageSha256: string;
  /** The compressed image; called only when it has to be written. */
  fetchImage: () => Promise<Uint8Array>;
  show?: (text: string) => void;
}): Promise<GuestRoot> {
  const { storage, imageSha256 } = options;
  if (storage === undefined) {
    return { kind: "memory", reason: "OPFS sync access is unavailable" };
  }
  const opened: SyncAccessHandleLike[] = [];
  try {
    const dir = await storage.getDirectoryHandle(DIRECTORY, { create: true });
    const imageName = `image-${imageSha256}.tar`;
    const doneName = `image-${imageSha256}.done`;
    const upperName = `upper-${crypto.randomUUID()}.bin`;
    await sweep(dir, new Set([imageName, doneName]));

    let wroteImage = false;
    let tarSize = await readDoneMarker(dir, doneName);
    if (tarSize === undefined) {
      const yurtimg = await options.fetchImage();
      options.show?.("writing the image to browser storage");
      const handle = await (await dir.getFileHandle(imageName, {
        create: true,
      })).createSyncAccessHandle();
      try {
        tarSize = writeDecompressed(handle, yurtimg);
        handle.flush();
      } finally {
        handle.close();
      }
      await writeDoneMarker(dir, doneName, tarSize);
      wroteImage = true;
    }
    // Shared where the browser can share (Chrome's read-only mode lets
    // several tabs read one file); elsewhere the option is ignored and the
    // handle is exclusive to this tab.
    const image = await (await dir.getFileHandle(imageName))
      .createSyncAccessHandle({ mode: "read-only" });
    opened.push(image);
    if (image.getSize() !== tarSize) {
      throw new Error(
        `stored image is ${image.getSize()} bytes, expected ${tarSize}`,
      );
    }
    const upper = await (await dir.getFileHandle(upperName, { create: true }))
      .createSyncAccessHandle();
    opened.push(upper);
    return {
      kind: "device",
      device: SyncHandleYurtDevice.fromImageTar(image, upper),
      wroteImage,
    };
  } catch (error) {
    for (const handle of opened) {
      try {
        handle.close();
      } catch {
        // Already closed or never usable: nothing to give back.
      }
    }
    return { kind: "memory", reason: storageFailure(error) };
  }
}

/** Remove what no live tab holds: other tabs' upper files (a live tab's
 * sync handle makes its file refuse removal) and other images. */
async function sweep(dir: OpfsDirectory, keep: Set<string>): Promise<void> {
  const names: string[] = [];
  for await (const name of dir.keys()) names.push(name);
  for (const name of names) {
    if (keep.has(name)) continue;
    try {
      await dir.removeEntry(name);
    } catch {
      // In use by another tab: its own boot sweeps it once it is gone.
    }
  }
}

async function readDoneMarker(
  dir: OpfsDirectory,
  name: string,
): Promise<number | undefined> {
  let handle: SyncAccessHandleLike;
  try {
    handle = await (await dir.getFileHandle(name)).createSyncAccessHandle({
      mode: "read-only",
    });
  } catch {
    return undefined;
  }
  try {
    const bytes = new Uint8Array(handle.getSize());
    handle.read(bytes, { at: 0 });
    const size = Number(new TextDecoder().decode(bytes));
    return Number.isSafeInteger(size) && size > 0 ? size : undefined;
  } finally {
    handle.close();
  }
}

async function writeDoneMarker(
  dir: OpfsDirectory,
  name: string,
  size: number,
): Promise<void> {
  const handle = await (await dir.getFileHandle(name, { create: true }))
    .createSyncAccessHandle();
  try {
    const bytes = new TextEncoder().encode(String(size));
    handle.truncate(0);
    handle.write(bytes, { at: 0 });
    handle.flush();
  } finally {
    handle.close();
  }
}

/** Decompress `yurtimg` straight into `handle`, a slice at a time, so the
 * whole tar is never in memory. Returns its size. */
export function writeDecompressed(
  handle: SyncAccessHandleLike,
  yurtimg: Uint8Array,
): number {
  handle.truncate(0);
  let at = 0;
  const stream = new Decompress((chunk) => {
    let done = 0;
    while (done < chunk.byteLength) {
      done += handle.write(chunk.subarray(done), { at: at + done });
    }
    at += chunk.byteLength;
  });
  for (let offset = 0; offset < yurtimg.byteLength; offset += INPUT_SLICE) {
    const end = Math.min(offset + INPUT_SLICE, yurtimg.byteLength);
    stream.push(yurtimg.subarray(offset, end), end === yurtimg.byteLength);
  }
  return at;
}

function storageFailure(error: unknown): string {
  const name = (error as { name?: string } | null)?.name;
  if (name === "NoModificationAllowedError") {
    return "the image is open in another tab";
  }
  if (name === "QuotaExceededError") return "browser storage is full";
  return `browser storage failed: ${
    error instanceof Error ? error.message : String(error)
  }`;
}
