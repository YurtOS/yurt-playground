// OPFS for Deno tests: a directory tree on disk with the locking rules of
// FileSystemSyncAccessHandle -- a "readwrite" handle is exclusive, several
// "read-only" handles may share a file, and a file with any open handle
// refuses removal -- which is what src/opfs_root.ts relies on across tabs.
import { join } from "node:path";
import type { SyncAccessHandleLike } from "@yurt/kernel-host-interface-js";
import type { OpfsDirectory, OpfsFile } from "../src/opfs_root.ts";

type Lock = { exclusive: boolean; readers: number };

function refused(message: string): DOMException {
  return new DOMException(message, "NoModificationAllowedError");
}

class FsSyncHandle implements SyncAccessHandleLike {
  private open = true;
  constructor(
    private readonly file: Deno.FsFile,
    private readonly release: () => void,
    private readonly readOnly: boolean,
  ) {}
  read(buffer: Uint8Array, options: { at?: number } = {}): number {
    this.file.seekSync(options.at ?? 0, Deno.SeekMode.Start);
    return this.file.readSync(buffer) ?? 0;
  }
  write(buffer: Uint8Array, options: { at?: number } = {}): number {
    if (this.readOnly) throw refused("read-only handle");
    this.file.seekSync(options.at ?? 0, Deno.SeekMode.Start);
    return this.file.writeSync(buffer);
  }
  truncate(size: number): void {
    if (this.readOnly) throw refused("read-only handle");
    this.file.truncateSync(size);
  }
  getSize(): number {
    return this.file.statSync().size;
  }
  flush(): void {}
  close(): void {
    if (!this.open) return;
    this.open = false;
    this.file.close();
    this.release();
  }
}

class FsOpfsFile implements OpfsFile {
  constructor(
    private readonly path: string,
    private readonly locks: Map<string, Lock>,
    private readonly counters: FsOpfsCounters,
    private readonly handles: Set<SyncAccessHandleLike>,
  ) {}

  createSyncAccessHandle(
    options: { mode?: "read-only" | "readwrite" } = {},
  ): Promise<SyncAccessHandleLike> {
    const readOnly = options.mode === "read-only";
    const lock = this.locks.get(this.path) ?? { exclusive: false, readers: 0 };
    if (lock.exclusive || (!readOnly && lock.readers > 0)) {
      return Promise.reject(refused(`${this.path} is locked`));
    }
    if (readOnly) lock.readers++;
    else lock.exclusive = true;
    this.locks.set(this.path, lock);
    if (!readOnly) this.counters.writableOpens.push(this.path);
    const file = Deno.openSync(this.path, { read: true, write: !readOnly });
    const handle: FsSyncHandle = new FsSyncHandle(file, () => {
      this.handles.delete(handle);
      if (readOnly) lock.readers--;
      else lock.exclusive = false;
      if (!lock.exclusive && lock.readers === 0) this.locks.delete(this.path);
    }, readOnly);
    this.handles.add(handle);
    return Promise.resolve(handle);
  }
}

export type FsOpfsCounters = { writableOpens: string[] };

export class FsOpfsDirectory implements OpfsDirectory {
  constructor(
    readonly path: string,
    readonly locks = new Map<string, Lock>(),
    readonly counters: FsOpfsCounters = { writableOpens: [] },
    /** This tab's open handles: a browser drops them with the worker. */
    private readonly handles = new Set<SyncAccessHandleLike>(),
  ) {}

  /** What a closing tab does to its handles. */
  closeAll(): void {
    for (const handle of [...this.handles]) handle.close();
  }

  async getDirectoryHandle(
    name: string,
    options: { create?: boolean } = {},
  ): Promise<OpfsDirectory> {
    const path = join(this.path, name);
    if (options.create) await Deno.mkdir(path, { recursive: true });
    else await Deno.stat(path);
    return new FsOpfsDirectory(path, this.locks, this.counters, this.handles);
  }

  async getFileHandle(
    name: string,
    options: { create?: boolean } = {},
  ): Promise<OpfsFile> {
    const path = join(this.path, name);
    try {
      await Deno.stat(path);
    } catch (error) {
      if (!options.create) {
        throw error instanceof Deno.errors.NotFound
          ? new DOMException(`${name} not found`, "NotFoundError")
          : error;
      }
      await Deno.writeFile(path, new Uint8Array());
    }
    return new FsOpfsFile(path, this.locks, this.counters, this.handles);
  }

  async removeEntry(name: string): Promise<void> {
    const path = join(this.path, name);
    if (this.locks.has(path)) throw refused(`${name} is in use`);
    await Deno.remove(path, { recursive: true });
  }

  async *keys(): AsyncIterable<string> {
    for await (const entry of Deno.readDir(this.path)) yield entry.name;
  }

  /** A second tab: same files and locks, its own handles. */
  otherTab(): FsOpfsDirectory {
    return new FsOpfsDirectory(this.path, this.locks, this.counters);
  }
}
