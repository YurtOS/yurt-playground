import { assertEquals, assertThrows } from "@std/assert";
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
    imageSha256: SHA,
    fetchImage: fixtureImage,
  });
  assertEquals(root, {
    kind: "memory",
    reason: "OPFS sync access is unavailable",
  });
});

Deno.test("openGuestRoot writes the image once and reuses it on reload", async () => {
  const yurtimg = await fixtureImage();
  await withStorage(async (storage) => {
    const first = await openGuestRoot({
      storage,
      imageSha256: SHA,
      fetchImage: () => Promise.resolve(yurtimg),
    });
    if (first.kind !== "device") throw new Error(JSON.stringify(first));
    assertEquals(first.wroteImage, true);
    assertEquals(decode(first.device.readFile("/bin/sh")), "#!shell\n");
    first.device.close();

    const writes = storage.counters.writableOpens.length;
    let fetched = 0;
    const second = await openGuestRoot({
      storage: storage.otherTab(),
      imageSha256: SHA,
      fetchImage: () => {
        fetched++;
        return Promise.resolve(yurtimg);
      },
    });
    // A reload with a complete copy does not download the image at all.
    assertEquals(fetched, 0);
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
    const live = await openGuestRoot({
      storage,
      imageSha256: SHA,
      fetchImage: () => Promise.resolve(yurtimg),
    });
    if (live.kind !== "device") throw new Error(JSON.stringify(live));
    const dir = join(storage.path, "yurt-fs");
    await Deno.writeFile(join(dir, "upper-stale.bin"), new Uint8Array(10));
    await Deno.writeFile(
      join(dir, `image-${"b".repeat(64)}.tar`),
      new Uint8Array(1),
    );

    const next = await openGuestRoot({
      storage: storage.otherTab(),
      imageSha256: SHA,
      fetchImage: () => Promise.resolve(yurtimg),
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
      imageSha256: SHA,
      fetchImage: () => Promise.resolve(yurtimg),
    });
    assertEquals(root, {
      kind: "memory",
      reason: "the image is open in another tab",
    });
    held.close();
  });
});

Deno.test("a done marker that disagrees with the stored image is dropped and the image written again", async () => {
  // A tab closed mid-write can leave the marker naming the full size over a
  // short image (Safari's exclusive handles make a second tab rewrite a
  // good image). Every later boot used to fall back to memory for good.
  const yurtimg = await fixtureImage();
  await withStorage(async (storage) => {
    const first = await openGuestRoot({
      storage,
      imageSha256: SHA,
      fetchImage: () => Promise.resolve(yurtimg),
    });
    if (first.kind !== "device") throw new Error(JSON.stringify(first));
    first.device.close();
    const image = join(storage.path, "yurt-fs", `image-${SHA}.tar`);
    await Deno.truncate(image, 512);

    const repaired = await openGuestRoot({
      storage: storage.otherTab(),
      imageSha256: SHA,
      fetchImage: () => Promise.resolve(yurtimg),
    });
    if (repaired.kind !== "device") throw new Error(JSON.stringify(repaired));
    assertEquals(repaired.wroteImage, true);
    assertEquals(decode(repaired.device.readFile("/etc/motd")).length, 30000);
    repaired.device.close();

    const reused = await openGuestRoot({
      storage: storage.otherTab(),
      imageSha256: SHA,
      fetchImage: () => Promise.reject(new Error("no download needed")),
    });
    if (reused.kind !== "device") throw new Error(JSON.stringify(reused));
    assertEquals(reused.wroteImage, false);
    reused.device.close();
  });
});

Deno.test("the guest's writes stop at the upper file's cap, as a full disk", async () => {
  // OPFS is bounded only by the origin's quota (often tens of GB), and the
  // upper file outlives the tab until the next visit sweeps it.
  const yurtimg = await fixtureImage();
  await withStorage(async (storage) => {
    const root = await openGuestRoot({
      storage,
      imageSha256: SHA,
      fetchImage: () => Promise.resolve(yurtimg),
      upperMaxBytes: 1 << 20,
    });
    if (root.kind !== "device") throw new Error(JSON.stringify(root));
    root.device.writeFile("/fits", new Uint8Array(512 * 1024));
    const error = assertThrows(() =>
      root.device.writeFile("/too-big", new Uint8Array(2 << 20))
    ) as { errno?: number };
    assertEquals(error.errno, 28, "ENOSPC");
    // What did fit is intact, and the failed file left no chunks behind.
    assertEquals(root.device.readFile("/fits")?.byteLength, 512 * 1024);
    const upper = [...Deno.readDirSync(join(storage.path, "yurt-fs"))]
      .find((entry) => entry.name.startsWith("upper-"))!;
    assertEquals(
      Deno.statSync(join(storage.path, "yurt-fs", upper.name)).size <=
        1 << 20,
      true,
    );
    root.device.close();
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

Deno.test("writeDecompressed fails rather than spin on a handle that takes nothing", async () => {
  const yurtimg = await fixtureImage();
  const stuck = {
    read: () => 0,
    write: () => 0,
    truncate: () => {},
    getSize: () => 0,
    flush: () => {},
    close: () => {},
  };
  assertThrows(
    () => writeDecompressed(stuck, yurtimg),
    Error,
    "accepted no bytes",
  );
});
