import { join } from "node:path";

const BLOCK = 512;

export async function canonicalTreeTar(root: string): Promise<Uint8Array> {
  const entries = await collect(root, "");
  entries.sort((a, b) => compareUtf8(a.path, b.path));
  const chunks: Uint8Array[] = [];
  for (const entry of entries) chunks.push(header(entry));
  chunks.push(new Uint8Array(BLOCK * 2));
  const output = new Uint8Array(
    chunks.reduce((n, chunk) => n + chunk.length, 0),
  );
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

type Entry = {
  path: string;
  kind: "file" | "directory" | "symlink";
  bytes?: Uint8Array;
  target?: string;
  executable?: boolean;
};

async function collect(root: string, prefix: string): Promise<Entry[]> {
  const entries: Entry[] = [];
  for await (const dirent of Deno.readDir(join(root, prefix))) {
    const path = prefix ? `${prefix}/${dirent.name}` : dirent.name;
    const info = await Deno.lstat(join(root, path));
    if (info.isDirectory) {
      entries.push({ path, kind: "directory" });
      entries.push(...await collect(root, path));
    } else if (info.isFile) {
      entries.push({
        path,
        kind: "file",
        bytes: await Deno.readFile(join(root, path)),
        executable: (info.mode ?? 0) & 0o111 ? true : false,
      });
    } else if (info.isSymlink) {
      const target = await Deno.readLink(join(root, path));
      const targetBytes = new TextEncoder().encode(target);
      if (target.includes("\0") || targetBytes.byteLength > 100) {
        throw new Error(
          `symlink target is not canonical USTAR-compatible: ${path}`,
        );
      }
      entries.push({ path, kind: "symlink", target });
    } else {
      throw new Error(
        `canonical tar does not support symlinks or special files: ${path}`,
      );
    }
  }
  return entries;
}

function header(entry: Entry): Uint8Array {
  const { name, prefix } = splitPath(entry.path);
  const block = new Uint8Array(BLOCK);
  block.set(name, 0);
  const mode = entry.kind === "directory"
    ? 0o755
    : entry.kind === "symlink"
    ? 0o777
    : entry.executable
    ? 0o755
    : 0o644;
  writeAscii(block, 100, 8, octal(mode, 7) + "\0");
  writeAscii(block, 108, 8, "0000000\0");
  writeAscii(block, 116, 8, "0000000\0");
  const size = entry.kind === "file" ? entry.bytes!.byteLength : 0;
  writeAscii(block, 124, 12, octal(size, 11));
  writeAscii(block, 136, 12, "00000000000\0");
  block.fill(0x20, 148, 156);
  block[156] = entry.kind === "directory"
    ? 53
    : entry.kind === "symlink"
    ? 50
    : 48;
  if (entry.kind === "symlink") writeAscii(block, 157, 100, entry.target!);
  writeAscii(block, 257, 6, "ustar\0");
  writeAscii(block, 263, 2, "00");
  writeAscii(block, 329, 8, "0000000\0");
  writeAscii(block, 337, 8, "0000000\0");
  block.set(prefix, 345);
  const checksum = block.reduce((sum, byte) => sum + byte, 0);
  writeAscii(block, 148, 8, octal(checksum, 6) + " \0");
  if (entry.kind === "file" && size > 0) {
    const padded = new Uint8Array(Math.ceil(size / BLOCK) * BLOCK);
    padded.set(entry.bytes!);
    const result = new Uint8Array(BLOCK + padded.length);
    result.set(block);
    result.set(padded, BLOCK);
    return result;
  }
  return block;
}

function splitPath(path: string): { name: Uint8Array; prefix: Uint8Array } {
  const encoded = new TextEncoder().encode(path);
  if (encoded.byteLength <= 100) {
    return { name: encoded, prefix: new Uint8Array() };
  }
  // Pick the rightmost slash whose UTF-8 byte lengths fit both USTAR fields.
  for (
    let slash = path.lastIndexOf("/");
    slash > 0;
    slash = path.lastIndexOf("/", slash - 1)
  ) {
    const prefix = new TextEncoder().encode(path.slice(0, slash));
    const name = new TextEncoder().encode(path.slice(slash + 1));
    if (prefix.byteLength <= 155 && name.byteLength <= 100) {
      return { name, prefix };
    }
  }
  throw new Error(`path exceeds canonical USTAR fields: ${path}`);
}

function octal(value: number, width: number): string {
  return value.toString(8).padStart(width, "0");
}

function compareUtf8(left: string, right: string): number {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

function writeAscii(
  target: Uint8Array,
  offset: number,
  width: number,
  value: string,
): void {
  target.set(new TextEncoder().encode(value.slice(0, width)), offset);
}
