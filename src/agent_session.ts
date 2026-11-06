/**
 * Where an agent run's sealed sandbox goes between runs. Its kernel memory is
 * about 550 MiB, which IndexedDB took over a minute to store: the memory goes to
 * a file in the origin's private file system, and the rest of the seal, which
 * names that file, to IndexedDB last. A seal cut short leaves the previous one.
 * Runs in the coordinator worker: synchronous file access needs a worker.
 */
import type { SandboxSealImage } from "@yurt/kernel-host-interface-js";
import {
  AGENT_SESSION_KEY,
  clearSnapshot,
  loadSnapshot,
  type StoredSnapshot,
  storeSnapshot,
} from "./snapshot_store.ts";

type SyncFile = {
  write(data: Uint8Array, options: { at: number }): number;
  read(data: Uint8Array, options: { at: number }): number;
  getSize(): number;
  truncate(size: number): void;
  flush(): void;
  close(): void;
};
type WorkerFileHandle = FileSystemFileHandle & {
  createSyncAccessHandle(): Promise<SyncFile>;
};

const MEMORY_FILE = /^agent-session-\d+\.memory$/;

/** Every session file but `keep`. */
async function removeMemoryFiles(
  root: FileSystemDirectoryHandle,
  keep?: string,
): Promise<void> {
  const names: string[] = [];
  for await (
    const name of (root as unknown as {
      keys(): AsyncIterable<string>;
    }).keys()
  ) {
    if (MEMORY_FILE.test(name) && name !== keep) names.push(name);
  }
  for (const name of names) await root.removeEntry(name).catch(() => {});
}

export async function saveAgentSession(
  image: SandboxSealImage,
  kernelSha256: string,
): Promise<void> {
  const root = await navigator.storage.getDirectory();
  const sealedAt = Date.now();
  const file = `agent-session-${sealedAt}.memory`;
  const handle = await root.getFileHandle(file, { create: true });
  const sync = await (handle as WorkerFileHandle).createSyncAccessHandle();
  try {
    const memory = image.kernelMemory;
    if (sync.write(memory, { at: 0 }) !== memory.byteLength) {
      throw new Error("the browser stored only part of the sandbox");
    }
    sync.flush();
  } finally {
    sync.close();
  }
  await storeSnapshot({
    image: { ...image, kernelMemory: new Uint8Array() },
    pty: 0,
    sealedAt,
    kernelSha256,
    attachments: { memoryFile: file },
  }, AGENT_SESSION_KEY);
  await removeMemoryFiles(root, file);
}

export async function loadAgentSession(): Promise<StoredSnapshot | undefined> {
  const saved = await loadSnapshot(AGENT_SESSION_KEY);
  const file = saved?.attachments?.memoryFile;
  if (saved === undefined || typeof file !== "string") return undefined;
  const root = await navigator.storage.getDirectory();
  const handle = await root.getFileHandle(file);
  const sync = await (handle as WorkerFileHandle).createSyncAccessHandle();
  try {
    const memory = new Uint8Array(sync.getSize());
    if (sync.read(memory, { at: 0 }) !== memory.byteLength) {
      throw new Error("the browser returned only part of the sandbox");
    }
    return { ...saved, image: { ...saved.image, kernelMemory: memory } };
  } finally {
    sync.close();
  }
}

export async function dropAgentSession(): Promise<void> {
  await clearSnapshot(AGENT_SESSION_KEY);
  await removeMemoryFiles(await navigator.storage.getDirectory());
}
