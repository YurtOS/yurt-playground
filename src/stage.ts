import {
  KERNEL_PID,
  type KernelHostInterface,
  METHOD,
  s,
} from "@yurt/kernel-host-interface-js";
import { buildTarImageIndex, TarImageRootProvider } from "@yurt/tar-image";
import { decompressYurtimg } from "./zstd.ts";

const NEG_EEXIST = -17;
/** `METHOD_KERNEL_VFS_SET_METADATA`. A host-control method (`kernel_only`)
 * that sets mode, owner and mtime in one kernel-authoritative call, which
 * is why it is used here rather than a `chmod` plus a `chown`: staging is
 * root (`setPidCredentials(KERNEL_PID, 0, 0)` below), so a `chmod` would
 * have been permitted too, but it would take three calls to say what this
 * says in one. The native host stages the same image through the same
 * method (`disk.rs`'s `set_entry_metadata`). Spelled here rather than
 * imported because the shared `METHOD` table does not carry the
 * host-control ids, the same as `SYS_CHOWN` above. */
const KERNEL_VFS_SET_METADATA = 33;
const S_IFDIR = 0o040_000;
const S_IFREG = 0o100_000;
const S_IFLNK = 0o120_000;
const MODE_PERM_MASK = 0o7777;
const NANOS_PER_SECOND = 1_000_000_000n;
const REGISTER_FILE_CHUNK_HEADER_BYTES = 12;
const DEFAULT_KERNEL_SCRATCH_LEN = 64 * 1024;

export function setPidCredentials(
  mk: KernelHostInterface,
  pid: number,
  uid: number,
  gid: number,
): void {
  const req = new Uint8Array(28);
  const view = new DataView(req.buffer);
  for (const [index, value] of [pid, uid, uid, uid, gid, gid, gid].entries()) {
    view.setUint32(index * 4, value >>> 0, true);
  }
  const { rc } = mk.syscall(METHOD.KERNEL_SET_PROCESS_CREDENTIALS, req, 0);
  if (Number(rc) !== 0) {
    throw new Error(`set credentials pid=${pid} uid=${uid}: rc=${rc}`);
  }
}

const SYS_CHOWN = 0x1_0023;
function chownPath(
  mk: KernelHostInterface,
  path: string,
  uid: number,
  gid: number,
): void {
  const pathBytes = s(path);
  const req = new Uint8Array(8 + pathBytes.byteLength);
  const view = new DataView(req.buffer);
  view.setUint32(0, uid >>> 0, true);
  view.setUint32(4, gid >>> 0, true);
  req.set(pathBytes, 8);
  const { rc } = mk.syscall(SYS_CHOWN, req, 0);
  if (Number(rc) !== 0) {
    throw new Error(`chown ${path} ${uid}:${gid} failed: rc=${rc}`);
  }
}

/** The `st_mode` type bits for an image entry: the kernel stores the mode
 * verbatim, so the node's kind travels with its permission bits (the tar
 * mode has none). A hardlink is staged as its own copy of the target's
 * bytes, so it is a regular file. */
function entryTypeBits(type: string): number {
  if (type === "dir") return S_IFDIR;
  if (type === "symlink") return S_IFLNK;
  return S_IFREG;
}

/** Apply the image's mode, owner, and mtime to a staged entry. */
function setEntryMetadata(
  mk: KernelHostInterface,
  path: string,
  entry: {
    type: string;
    mode: number;
    uid: number;
    gid: number;
    mtime: number;
  },
): void {
  const pathBytes = s(path);
  const req = new Uint8Array(20 + pathBytes.byteLength);
  const view = new DataView(req.buffer);
  view.setUint32(
    0,
    (entryTypeBits(entry.type) | (entry.mode & MODE_PERM_MASK)) >>> 0,
    true,
  );
  view.setUint32(4, entry.uid >>> 0, true);
  view.setUint32(8, entry.gid >>> 0, true);
  view.setBigUint64(
    12,
    BigInt(Math.trunc(entry.mtime)) * NANOS_PER_SECOND,
    true,
  );
  req.set(pathBytes, 20);
  const { rc } = mk.syscall(KERNEL_VFS_SET_METADATA, req, 0);
  if (Number(rc) !== 0) {
    throw new Error(
      `set metadata on ${path} (mode ${
        entry.mode.toString(8)
      }) failed: rc=${rc}`,
    );
  }
}

/**
 * Stage the image into the kernel's ramfs. `include` keeps only the entries
 * it accepts (directories are always kept): the ramfs lives in the kernel's
 * memory, and a sandbox that will be sealed pays for every staged byte on
 * every seal, so a demo stages what its one program needs.
 */
export async function stageYurtimg(
  mk: KernelHostInterface,
  yurtimg: Uint8Array,
  host: Map<string, Uint8Array>,
  include: (path: string) => boolean = () => true,
): Promise<void> {
  setPidCredentials(mk, KERNEL_PID, 0, 0);
  const tarBytes = decompressYurtimg(yurtimg);
  const index = await buildTarImageIndex(tarBytes);
  const provider = new TarImageRootProvider({
    id: `sha256:${index.imageSha256}`,
    index,
    image: tarBytes,
  });
  const knownDirectories = new Set<string>();
  for (const path of imageDirectories(index)) {
    registerRamfsDirectory(mk, path);
    knownDirectories.add(path);
  }
  for (const [path, entry] of Object.entries(index.entries)) {
    if (entry.type !== "file" && entry.type !== "hardlink") continue;
    if (!include(path)) continue;
    stageRamfsFile(
      mk,
      host,
      path,
      provider.readFile(path),
      knownDirectories,
    );
  }
  for (const [path, entry] of Object.entries(index.entries)) {
    if (entry.type !== "symlink") continue;
    if (!include(path)) continue;
    registerRamfsSymlink(mk, entry.target, path);
    try {
      host.set(path, provider.readFile(path));
    } catch {
      // Dangling or non-file symlink: valid VFS entry, not a module.
    }
  }
  // The install calls above give a file the ramfs default (0644, or 0755
  // when its content is wasm) and every node the stager's root identity,
  // so apply what the image records -- mode, owner and mtime -- to every
  // staged entry (YurtOS/yurtos-kernel#3611: a 0755 `pip` launcher staged
  // 0644 and failed exec with EACCES). One pass after all structure, as the
  // runner's `stageImage` and Wasmtime's `boot_disk` do: a recorded 0700
  // directory applied early would refuse the entries staged beneath it.
  // Directories go last for the same reason, should the lookup ever check
  // search permission.
  const entries = Object.entries(index.entries);
  for (const [path, entry] of entries) {
    if (entry.type === "dir" || !include(path)) continue;
    setEntryMetadata(mk, path, entry);
  }
  for (const [path, entry] of entries) {
    if (entry.type === "dir") setEntryMetadata(mk, path, entry);
  }
}

function imageDirectories(
  index: { entries: Record<string, { type: string }> },
): string[] {
  const dirs = new Set<string>();
  for (const [path, entry] of Object.entries(index.entries)) {
    if (entry.type === "dir") dirs.add(path);
    for (const parent of parentDirectories(path)) dirs.add(parent);
  }
  dirs.delete("/");
  return [...dirs].sort((a, b) => {
    const depth = (p: string) => p.split("/").length;
    return depth(a) - depth(b) || a.localeCompare(b);
  });
}

function parentDirectories(path: string): string[] {
  const parts = path.split("/").filter((part) => part.length > 0);
  const dirs: string[] = [];
  let prefix = "";
  for (let i = 0; i < parts.length - 1; i++) {
    prefix += `/${parts[i]}`;
    dirs.push(prefix);
  }
  return dirs;
}

function registerRamfsDirectory(mk: KernelHostInterface, path: string): void {
  const { rc } = mk.syscall(METHOD.KERNEL_FS_MKDIR, s(path), 0);
  const code = Number(rc);
  if (code !== 0 && code !== NEG_EEXIST) {
    throw new Error(`kernel mkdir failed for ${path}: rc=${rc}`);
  }
}

function registerRamfsSymlink(
  mk: KernelHostInterface,
  target: string,
  linkPath: string,
): void {
  const targetBytes = s(target);
  const linkBytes = s(linkPath);
  const req = new Uint8Array(4 + targetBytes.byteLength + linkBytes.byteLength);
  new DataView(req.buffer).setUint32(0, targetBytes.byteLength >>> 0, true);
  req.set(targetBytes, 4);
  req.set(linkBytes, 4 + targetBytes.byteLength);
  const { rc } = mk.syscall(METHOD.KERNEL_FS_SYMLINK, req, 0);
  if (Number(rc) !== 0) {
    throw new Error(`kernel symlink failed for ${linkPath}: rc=${rc}`);
  }
}

/** Write `bytes` to `path` from the host, in scratch-sized chunks when
 * large: binary-safe and without a guest process (what a driver's stdin is
 * staged with, src/boot.ts). The file is the kernel's (root-owned, 0644)
 * unless an `owner` is given: root's is what a file a guest may read but
 * must not replace needs (the notebook's cell server). A file the login
 * user has to remove takes that user as `owner`, because a sticky directory
 * such as /tmp will not let it unlink a root file. */
export function writeRamfsFile(
  mk: KernelHostInterface,
  path: string,
  bytes: Uint8Array,
  owner?: { uid: number; gid: number },
): void {
  const pathBytes = s(path);
  const scratch = typeof mk.scratchLen === "number"
    ? mk.scratchLen
    : DEFAULT_KERNEL_SCRATCH_LEN;
  if (4 + pathBytes.byteLength + bytes.byteLength <= scratch) {
    mk.registerRamfsFile(pathBytes, bytes);
  } else {
    const chunkSize = scratch - REGISTER_FILE_CHUNK_HEADER_BYTES -
      pathBytes.byteLength;
    if (chunkSize <= 0) {
      throw new Error(`kernel scratch buffer is too small to write ${path}`);
    }
    let offset = 0;
    while (offset < bytes.byteLength) {
      const chunk = bytes.subarray(offset, offset + chunkSize);
      mk.registerRamfsFileChunk(pathBytes, offset, chunk);
      offset += chunk.byteLength;
    }
  }
  if (owner !== undefined) {
    chownPath(mk, path, owner.uid, owner.gid);
  }
}

/** {@link writeRamfsFile} after creating each missing parent directory
 * (root's, as the kernel makes them). */
export function writeRamfsTree(
  mk: KernelHostInterface,
  path: string,
  bytes: Uint8Array,
): void {
  for (const parent of parentDirectories(path)) {
    registerRamfsDirectory(mk, parent);
  }
  writeRamfsFile(mk, path, bytes);
}

function stageRamfsFile(
  mk: KernelHostInterface,
  host: Map<string, Uint8Array>,
  path: string,
  bytes: Uint8Array,
  knownDirectories: Set<string>,
): void {
  for (const parent of parentDirectories(path)) {
    if (knownDirectories.has(parent)) continue;
    registerRamfsDirectory(mk, parent);
    knownDirectories.add(parent);
  }
  const pathBytes = s(path);
  const scratch = typeof mk.scratchLen === "number"
    ? mk.scratchLen
    : DEFAULT_KERNEL_SCRATCH_LEN;
  if (4 + pathBytes.byteLength + bytes.byteLength <= scratch) {
    mk.registerRamfsFile(pathBytes, bytes);
  } else {
    const chunkSize = scratch - REGISTER_FILE_CHUNK_HEADER_BYTES -
      pathBytes.byteLength;
    if (chunkSize <= 0) {
      throw new Error(`kernel scratch buffer is too small to stage ${path}`);
    }
    let offset = 0;
    while (offset < bytes.byteLength) {
      const chunk = bytes.subarray(offset, offset + chunkSize);
      mk.registerRamfsFileChunk(pathBytes, offset, chunk);
      offset += chunk.byteLength;
    }
  }
  host.set(path, bytes);
}

/** One file of a zstd-compressed tar (a `.yurtimg`, or a `.yurtpkg`
 * archive): its bytes, or an error naming what is missing. */
export async function readYurtimgFile(
  yurtimg: Uint8Array,
  path: string,
): Promise<Uint8Array> {
  const tarBytes = decompressYurtimg(yurtimg);
  const index = await buildTarImageIndex(tarBytes);
  if (index.entries[path]?.type !== "file") {
    throw new Error(`the archive has no file ${path}`);
  }
  const provider = new TarImageRootProvider({
    id: `sha256:${index.imageSha256}`,
    index,
    image: tarBytes,
  });
  return provider.readFile(path);
}

/* The kernel's host-control VFS export (`kernel_only`, the ids the native
 * disk sync uses; not in the shared `METHOD` table): what changed since the
 * last drain, and each entry's metadata, bytes or target. */
const KERNEL_DRAIN_DIRTY_PATHS = 26;
const KERNEL_VFS_STAT = 27;
const KERNEL_VFS_READDIR = 28;
const KERNEL_VFS_READ = 29;
const KERNEL_VFS_READLINK = 30;
const KERNEL_VFS_UNLINK_TREE = 32;

/** One entry of a filesystem layer: what a tar entry holds. `mtime` in
 * seconds. */
export type LayerEntry =
  | {
    type: "dir";
    path: string;
    mode: number;
    uid: number;
    gid: number;
    mtime: number;
  }
  | {
    type: "file";
    path: string;
    mode: number;
    uid: number;
    gid: number;
    mtime: number;
    bytes: Uint8Array;
  }
  | {
    type: "symlink";
    path: string;
    mode: number;
    uid: number;
    gid: number;
    mtime: number;
    target: string;
  };

function responseCap(mk: KernelHostInterface): number {
  const scratch = typeof mk.scratchLen === "number"
    ? mk.scratchLen
    : DEFAULT_KERNEL_SCRATCH_LEN;
  return scratch - 64;
}

const textDecoder = new TextDecoder();

/** Every path the guest's filesystem marked as touched since the last
 * drain (creates, writes, renames, removals; one set), and the log empty
 * again. A path may no longer exist. */
export function drainDirtyPaths(mk: KernelHostInterface): string[] {
  const paths: string[] = [];
  for (;;) {
    const { rc, response } = mk.syscall(
      KERNEL_DRAIN_DIRTY_PATHS,
      new Uint8Array(),
      responseCap(mk),
    );
    const written = Number(rc);
    if (written < 0) throw new Error(`drain dirty paths: rc=${rc}`);
    if (written === 0) return paths;
    const view = new DataView(
      response.buffer,
      response.byteOffset,
      response.byteLength,
    );
    let at = 0;
    while (at + 4 <= written) {
      const length = view.getUint32(at, true);
      paths.push(
        textDecoder.decode(response.subarray(at + 4, at + 4 + length)),
      );
      at += 4 + length;
    }
  }
}

/** An entry's type and metadata, not following a final symlink;
 * `undefined` when there is none. `mtime` in seconds. */
export function vfsStat(
  mk: KernelHostInterface,
  path: string,
):
  | {
    type: "dir" | "file" | "symlink" | "other";
    mode: number;
    uid: number;
    gid: number;
    size: number;
    mtime: number;
  }
  | undefined {
  const { rc, response } = mk.syscall(KERNEL_VFS_STAT, s(path), 32);
  const code = Number(rc);
  // Gone (or a parent that is no directory now): no entry. Anything else
  // is an error, not an absence a layer may silently skip.
  if (code === -2 || code === -20) return undefined;
  if (code !== 32) throw new Error(`stat ${path}: rc=${rc}`);
  const view = new DataView(
    response.buffer,
    response.byteOffset,
    response.byteLength,
  );
  const filetype = view.getUint32(0, true);
  return {
    type: filetype === 3
      ? "dir"
      : filetype === 4
      ? "file"
      : filetype === 7
      ? "symlink"
      : "other",
    mode: view.getUint32(4, true) & MODE_PERM_MASK,
    uid: view.getUint32(8, true),
    gid: view.getUint32(12, true),
    size: Number(view.getBigUint64(16, true)),
    mtime: Number(view.getBigUint64(24, true) / NANOS_PER_SECOND),
  };
}

/** A VFS read's request (offset 0, then `path`; `view` sets the offset),
 * and the most it can answer: the request and the response share the
 * kernel's scratch buffer. */
function vfsReadRequest(mk: KernelHostInterface, path: string) {
  const pathBytes = s(path);
  const request = new Uint8Array(8 + pathBytes.byteLength);
  request.set(pathBytes, 8);
  return {
    request,
    view: new DataView(request.buffer),
    cap: responseCap(mk) - request.byteLength,
  };
}

/** The errnos the kernel's VFS read answers with, in words. */
const ENOENT = 2;
const ERRNO_WORDS: Record<number, string> = {
  2: "no such file",
  5: "I/O error",
  9: "bad file descriptor",
  21: "is a directory",
  22: "invalid argument",
  40: "too many levels of symbolic links",
};
function errnoText(rc: number): string {
  return ERRNO_WORDS[-rc] ?? `error ${-rc}`;
}

/** A regular file's bytes (`size` of them, as its stat says). */
export function vfsReadFile(
  mk: KernelHostInterface,
  path: string,
  size: number,
): Uint8Array {
  const out = new Uint8Array(size);
  const { request, view, cap } = vfsReadRequest(mk, path);
  let at = 0;
  while (at < size) {
    view.setBigUint64(0, BigInt(at), true);
    const { rc, response } = mk.syscall(
      KERNEL_VFS_READ,
      request,
      Math.min(cap, size - at),
    );
    const count = Number(rc);
    if (count < 0) throw new Error(`read ${path}: rc=${rc}`);
    if (count === 0) break;
    out.set(response.subarray(0, count), at);
    at += count;
  }
  if (at !== size) {
    throw new Error(`read ${path}: ${at} of ${size} bytes`);
  }
  return out;
}

/** A whole file in one VFS read, so one version of it even if it is
 * replaced meanwhile; `undefined` when there is none. A file that fills
 * the read (the kernel's scratch room) may go on past it, and throws. */
export function vfsReadWhole(
  mk: KernelHostInterface,
  path: string,
): Uint8Array | undefined {
  const { request, cap } = vfsReadRequest(mk, path);
  const { rc, response } = mk.syscall(KERNEL_VFS_READ, request, cap);
  const count = Number(rc);
  if (count === -ENOENT) return undefined;
  if (count < 0) throw new Error(`read ${path}: ${errnoText(count)}`);
  if (count >= cap) {
    throw new Error(`${path} does not fit one read (${cap} bytes)`);
  }
  return response.slice(0, count);
}

/** A symlink's target. */
export function vfsReadlink(mk: KernelHostInterface, path: string): string {
  const { rc, response } = mk.syscall(KERNEL_VFS_READLINK, s(path), 4096);
  const length = Number(rc);
  if (length < 0) throw new Error(`readlink ${path}: rc=${rc}`);
  return textDecoder.decode(response.subarray(0, length));
}

/** A directory's entry names (no `.` or `..`). */
export function vfsReaddir(mk: KernelHostInterface, path: string): string[] {
  const request = s(path);
  const most = responseCap(mk) - request.byteLength;
  let cap = Math.min(16 * 1024, most);
  for (;;) {
    const { rc, response } = mk.syscall(KERNEL_VFS_READDIR, request, cap);
    const needed = Number(rc);
    if (needed < 0) throw new Error(`readdir ${path}: rc=${rc}`);
    if (needed > cap) {
      if (needed > most) {
        throw new Error(`readdir ${path}: ${needed} bytes of names`);
      }
      cap = needed;
      continue;
    }
    const view = new DataView(
      response.buffer,
      response.byteOffset,
      response.byteLength,
    );
    const names: string[] = [];
    let at = 0;
    while (at + 5 <= needed) {
      const length = view.getUint32(at + 1, true);
      names.push(
        textDecoder.decode(response.subarray(at + 5, at + 5 + length)),
      );
      at += 5 + length;
    }
    return names;
  }
}

/** Write a layer's entries into the guest's filesystem as the kernel, the
 * way {@link stageYurtimg} stages an image: directories, then files and
 * symlinks (replacing whatever is at their paths), then each entry's mode,
 * owner and mtime -- directories last, so a 0700 one does not refuse the
 * entries beneath it. No guest process is involved. */
export function stageLayer(
  mk: KernelHostInterface,
  entries: LayerEntry[],
): void {
  setPidCredentials(mk, KERNEL_PID, 0, 0);
  const dirs = new Set<string>();
  for (const entry of entries) {
    for (const parent of parentDirectories(entry.path)) dirs.add(parent);
    if (entry.type === "dir") dirs.add(entry.path);
  }
  const ordered = [...dirs].sort((a, b) =>
    a.split("/").length - b.split("/").length || a.localeCompare(b)
  );
  for (const dir of ordered) {
    if (vfsStat(mk, dir)?.type === "symlink") continue;
    registerRamfsDirectory(mk, dir);
  }
  for (const entry of entries) {
    if (entry.type === "dir") continue;
    const existing = vfsStat(mk, entry.path);
    if (existing !== undefined) {
      const { rc } = mk.syscall(KERNEL_VFS_UNLINK_TREE, s(entry.path), 0);
      if (Number(rc) !== 0) {
        throw new Error(`replace ${entry.path}: rc=${rc}`);
      }
    }
    if (entry.type === "file") writeRamfsFile(mk, entry.path, entry.bytes);
    else registerRamfsSymlink(mk, entry.target, entry.path);
  }
  for (const entry of entries) {
    if (entry.type !== "dir") setEntryMetadata(mk, entry.path, entry);
  }
  for (const entry of entries) {
    if (entry.type === "dir") setEntryMetadata(mk, entry.path, entry);
  }
}
