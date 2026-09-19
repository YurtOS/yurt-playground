/**
 * Where the continuous-snapshot demo keeps its newest sandbox image: one
 * IndexedDB record, overwritten on every seal. IndexedDB structured-clones
 * the image as is (`Uint8Array`s and the `bigint` kernel token), holds far
 * more than the ~10 MB an image weighs, and outlives the tab — which is the
 * whole demo.
 */
import type { SandboxSealImage } from "@yurt/kernel-host-interface-js";

/** Written into the terminal (and the page driver's output) at a restore. */
export const RESTORE_MARKER = "--- restored from snapshot ---";

const DB_NAME = "yurt-snapshot-demo";
const STORE = "images";
/** The continuous-snapshot demo's record. */
const KEY = "newest";
/** The notebook kernel's record (src/notebook_kernel_worker.ts). */
export const NOTEBOOK_KEY = "notebook";

export type StoredSnapshot = {
  image: SandboxSealImage;
  /** The host pty the guest's terminal is on; it lives in the kernel image,
   *  the pump on the page does not. */
  pty: number;
  sealedAt: number;
  /** SHA-256 of the kernel.wasm the image was sealed under. A kernel memory
   *  image only means something to the binary that produced it; after a
   *  kernel pin bump the image is dropped rather than installed over a
   *  different build. */
  kernelSha256: string;
  /** Host-side state the image cannot carry, for the owner of the record
   *  to restore alongside it (the notebook kernel's cell in progress). */
  attachments?: Record<string, unknown>;
};

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(
    new Uint8Array(digest),
    (b) => b.toString(16).padStart(2, "0"),
  )
    .join("");
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB failed"));
  });
}

async function open(): Promise<IDBDatabase> {
  const req = indexedDB.open(DB_NAME, 1);
  req.onupgradeneeded = () => {
    req.result.createObjectStore(STORE);
  };
  return await request(req);
}

export async function storeSnapshot(
  snapshot: StoredSnapshot,
  key = KEY,
): Promise<void> {
  const db = await open();
  try {
    const tx = db.transaction(STORE, "readwrite");
    await request(tx.objectStore(STORE).put(snapshot, key));
  } finally {
    db.close();
  }
}

export async function loadSnapshot(
  key = KEY,
): Promise<StoredSnapshot | undefined> {
  const db = await open();
  try {
    const tx = db.transaction(STORE, "readonly");
    const found = await request(tx.objectStore(STORE).get(key));
    return (found ?? undefined) as StoredSnapshot | undefined;
  } finally {
    db.close();
  }
}

export async function clearSnapshot(key = KEY): Promise<void> {
  const db = await open();
  try {
    const tx = db.transaction(STORE, "readwrite");
    await request(tx.objectStore(STORE).delete(key));
  } finally {
    db.close();
  }
}
