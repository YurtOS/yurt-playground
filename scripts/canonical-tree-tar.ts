import { basename, join } from "node:path";

const BLOCK = 512;

export async function canonicalTreeTar(root: string): Promise<Uint8Array> {
  const entries = await collect(root, "");
  entries.sort((a, b) => a.path.localeCompare(b.path));
  const chunks: Uint8Array[] = [];
  for (const entry of entries) chunks.push(await header(entry));
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

type Entry = { path: string; kind: "file" | "directory"; bytes?: Uint8Array };

async function collect(root: string, prefix: string): Promise<Entry[]> {
  const entries: Entry[] = [];
  for await (const dirent of Deno.readDir(join(root, prefix))) {
    const path = prefix ? `${prefix}/${dirent.name}` : dirent.name;
    if (dirent.isDirectory) {
      entries.push({ path: `${path}/`, kind: "directory" });
      entries.push(...await collect(root, path));
    } else if (dirent.isFile) {
      entries.push({
        path,
        kind: "file",
        bytes: await Deno.readFile(join(root, path)),
      });
    } else {
      throw new Error(
        `canonical tar does not support symlinks or special files: ${path}`,
      );
    }
  }
  return entries;
}

async function header(entry: Entry): Promise<Uint8Array> {
  const name = new TextEncoder().encode(entry.path);
  if (name.byteLength > 100) {
    throw new Error(`path exceeds canonical USTAR name field: ${entry.path}`);
  }
  const block = new Uint8Array(BLOCK);
  block.set(name, 0);
  writeAscii(block, 100, 8, "0000000\0");
  writeAscii(block, 108, 8, "0000000\0");
  writeAscii(block, 116, 8, "0000000\0");
  const size = entry.kind === "file" ? entry.bytes!.byteLength : 0;
  writeAscii(block, 124, 12, octal(size, 11));
  writeAscii(block, 136, 12, "00000000000\0");
  block.fill(0x20, 148, 156);
  block[156] = entry.kind === "directory" ? 53 : 48;
  writeAscii(block, 257, 6, "ustar\0");
  writeAscii(block, 263, 2, "00");
  writeAscii(block, 329, 8, "0000000\0");
  writeAscii(block, 337, 8, "0000000\0");
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

function octal(value: number, width: number): string {
  return value.toString(8).padStart(width, "0");
}

function writeAscii(
  target: Uint8Array,
  offset: number,
  width: number,
  value: string,
): void {
  target.set(new TextEncoder().encode(value.slice(0, width)), offset);
}
