import { assertEquals } from "@std/assert";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import { canonicalTreeTar } from "../scripts/canonical-tree-tar.ts";
import { decompressYurtimg } from "../src/zstd.ts";
import { openGuestRoot, writeDecompressed } from "../src/opfs_root.ts";
import { FsOpfsDirectory } from "./opfs_fake.ts";

const SHA = "a".repeat(64);

async function fixtureImage(): Promise<Uint8Array> {
  const tree = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(tree, "bin"));
    await Deno.writeTextFile(join(tree, "bin/sh"), "#!shell\n");
    await Deno.mkdir(join(tree, "etc"));
    await Deno.writeTextFile(join(tree, "etc/motd"), "hello\n".repeat(5000));
    return new Uint8Array(zstdCompressSync(await canonicalTreeTar(tree)));
  } finally {
    await Deno.remove(tree, { recursive: true });
  }
}

async function withStorage(
  fn: (storage: FsOpfsDirectory) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  try {
    await fn(new FsOpfsDirectory(dir));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

const decode = (bytes: Uint8Array | undefined) =>
  new TextDecoder().decode(bytes);

Deno.test("openGuestRoot without OPFS stays in memory and says why", async () => {
  const root = await openGuestRoot({
    storage: undefined,
    yurtimg: await fixtureImage(),
    imageSha256: SHA,
  });
  assertEquals(root, {
    kind: "memory",
    reason: "OPFS sync access is unavailable",
  });
});

Deno.test("openGuestRoot writes the image once and reuses it on reload", async () => {
  const yurtimg = await fixtureImage();
  await withStorage(async (storage) => {
    const first = await openGuestRoot({ storage, yurtimg, imageSha256: SHA });
    if (first.kind !== "device") throw new Error(JSON.stringify(first));
    assertEquals(first.wroteImage, true);
    assertEquals(decode(first.device.readFile("/bin/sh")), "#!shell\n");
    first.device.close();

    const writes = storage.counters.writableOpens.length;
    const second = await openGuestRoot({
      storage: storage.otherTab(),
      yurtimg,
      imageSha256: SHA,
    });
    if (second.kind !== "device") throw new Error(JSON.stringify(second));
    assertEquals(second.wroteImage, false);
    assertEquals(decode(second.device.readFile("/etc/motd")).length, 30000);
    // Only the new tab's upper file was opened for writing.
    const opened = storage.counters.writableOpens.slice(writes);
    assertEquals(opened.length, 1);
    assertEquals(
      /\/upper-[0-9a-f-]{36}\.bin$/.test(opened[0]),
      true,
      opened[0],
    );
    second.device.close();
  });
});

Deno.test("openGuestRoot sweeps stale files but not a live tab's", async () => {
  const yurtimg = await fixtureImage();
  await withStorage(async (storage) => {
    const live = await openGuestRoot({ storage, yurtimg, imageSha256: SHA });
    if (live.kind !== "device") throw new Error(JSON.stringify(live));
    const dir = join(storage.path, "yurt-fs");
    await Deno.writeFile(join(dir, "upper-stale.bin"), new Uint8Array(10));
    await Deno.writeFile(
      join(dir, `image-${"b".repeat(64)}.tar`),
      new Uint8Array(1),
    );

    const next = await openGuestRoot({
      storage: storage.otherTab(),
      yurtimg,
      imageSha256: SHA,
    });
    if (next.kind !== "device") throw new Error(JSON.stringify(next));
    const names: string[] = [];
    for await (const entry of Deno.readDir(dir)) names.push(entry.name);
    assertEquals(names.includes("upper-stale.bin"), false);
    assertEquals(names.some((name) => name.startsWith(`image-${"b"}`)), false);
    // Both live tabs keep their own upper file.
    assertEquals(names.filter((name) => name.startsWith("upper-")).length, 2);
    live.device.close();
    next.device.close();
  });
});

Deno.test("openGuestRoot falls back when another tab holds the image", async () => {
  const yurtimg = await fixtureImage();
  await withStorage(async (storage) => {
    const dir = await storage.getDirectoryHandle("yurt-fs", { create: true });
    // A tab mid-write holds the image exclusively (Safari holds it so for
    // as long as the tab runs).
    const held = await (await dir.getFileHandle(`image-${SHA}.tar`, {
      create: true,
    })).createSyncAccessHandle();
    const root = await openGuestRoot({
      storage: storage.otherTab(),
      yurtimg,
      imageSha256: SHA,
    });
    assertEquals(root, {
      kind: "memory",
      reason: "the image is open in another tab",
    });
    held.close();
  });
});

Deno.test("writeDecompressed streams the tar into the handle", async () => {
  const yurtimg = await fixtureImage();
  await withStorage(async (storage) => {
    const handle = await (await storage.getFileHandle("t", { create: true }))
      .createSyncAccessHandle();
    const size = writeDecompressed(handle, yurtimg);
    const expected = decompressYurtimg(yurtimg);
    const got = new Uint8Array(handle.getSize());
    handle.read(got, { at: 0 });
    handle.close();
    assertEquals(size, expected.byteLength);
    assertEquals(got, expected);
  });
});
