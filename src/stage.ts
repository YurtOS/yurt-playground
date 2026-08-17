import {
  type KernelHostInterface,
  METHOD,
  s,
} from "@yurt/kernel-host-interface-js";
import { buildTarImageIndex, TarImageRootProvider } from "@yurt/tar-image";
import { decompressYurtimg } from "./zstd.ts";

const NEG_EEXIST = -17;
const REGISTER_FILE_CHUNK_HEADER_BYTES = 12;
const DEFAULT_KERNEL_SCRATCH_LEN = 64 * 1024;

export async function stageYurtimg(
  mk: KernelHostInterface,
  yurtimg: Uint8Array,
  host: Map<string, Uint8Array>,
): Promise<void> {
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
    registerRamfsSymlink(mk, entry.target, path);
    try {
      host.set(path, provider.readFile(path));
    } catch {
      // Dangling or non-file symlink: valid VFS entry, not a module.
    }
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
