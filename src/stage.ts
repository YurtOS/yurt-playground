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
const SYS_LCHOWN = 0x1_01D2;

export function ownershipMethodForEntry(type: string): number {
  return type === "symlink" ? SYS_LCHOWN : SYS_CHOWN;
}

function chownPath(
  mk: KernelHostInterface,
  path: string,
  uid: number,
  gid: number,
  method: number,
): void {
  const pathBytes = s(path);
  const req = new Uint8Array(8 + pathBytes.byteLength);
  const view = new DataView(req.buffer);
  view.setUint32(0, uid >>> 0, true);
  view.setUint32(4, gid >>> 0, true);
  req.set(pathBytes, 8);
  const { rc } = mk.syscall(method, req, 0);
  if (Number(rc) !== 0) {
    throw new Error(`chown ${path} ${uid}:${gid} failed: rc=${rc}`);
  }
}

/** Apply the image's mode, owner, and mtime to a staged directory. */
function setDirectoryMetadata(
  mk: KernelHostInterface,
  path: string,
  entry: { mode: number; uid: number; gid: number; mtime: number },
): void {
  const pathBytes = s(path);
  const req = new Uint8Array(20 + pathBytes.byteLength);
  const view = new DataView(req.buffer);
  // The kernel stores this mode verbatim, so include the directory type.
  view.setUint32(0, (S_IFDIR | (entry.mode & MODE_PERM_MASK)) >>> 0, true);
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
  for (const [path, entry] of Object.entries(index.entries)) {
    if (entry.type === "dir") continue;
    if (entry.uid === 0 && entry.gid === 0) continue;
    if (!include(path)) continue;
    chownPath(
      mk,
      path,
      entry.uid,
      entry.gid,
      ownershipMethodForEntry(entry.type),
    );
  }
  // Apply these modes last: mkdir, symlink, and chown above are
  // permission-checked, and root still needs search permission through ancestors.
  for (const [path, entry] of Object.entries(index.entries)) {
    if (entry.type !== "dir") continue;
    setDirectoryMetadata(mk, path, entry);
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
 * staged with, src/boot.ts). The file is the kernel's (root-owned, 0644),
 * which a reader needs and a writer does not get. */
export function writeRamfsFile(
  mk: KernelHostInterface,
  path: string,
  bytes: Uint8Array,
): void {
  const pathBytes = s(path);
  const scratch = typeof mk.scratchLen === "number"
    ? mk.scratchLen
    : DEFAULT_KERNEL_SCRATCH_LEN;
  if (4 + pathBytes.byteLength + bytes.byteLength <= scratch) {
    mk.registerRamfsFile(pathBytes, bytes);
    return;
  }
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
