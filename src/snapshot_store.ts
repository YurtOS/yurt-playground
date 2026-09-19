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
const KEY = "newest";

export type StoredSnapshot = {
  image: SandboxSealImage;
  /** The host pty the guest's terminal is on; it lives in the kernel image,
   *  the pump on the page does not. */
  pty: number;
  sealedAt: number;
};

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

export async function storeSnapshot(snapshot: StoredSnapshot): Promise<void> {
  const db = await open();
  try {
    const tx = db.transaction(STORE, "readwrite");
    await request(tx.objectStore(STORE).put(snapshot, KEY));
  } finally {
    db.close();
  }
}

export async function loadSnapshot(): Promise<StoredSnapshot | undefined> {
  const db = await open();
  try {
    const tx = db.transaction(STORE, "readonly");
    const found = await request(tx.objectStore(STORE).get(KEY));
    return (found ?? undefined) as StoredSnapshot | undefined;
  } finally {
    db.close();
  }
}

export async function clearSnapshot(): Promise<void> {
  const db = await open();
  try {
    const tx = db.transaction(STORE, "readwrite");
    await request(tx.objectStore(STORE).delete(KEY));
  } finally {
    db.close();
  }
}
