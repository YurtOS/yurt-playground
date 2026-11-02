import { assertEquals, assertRejects } from "@std/assert";
import {
  crc32,
  writeZip,
  type ZipEntry,
  ZipStreamReader,
} from "../src/snapshot_zip.ts";

async function readAll(
  file: Blob,
): Promise<{ entry: ZipEntry; bytes: Uint8Array }[]> {
  const zip = new ZipStreamReader(file.stream().getReader());
  const out: { entry: ZipEntry; bytes: Uint8Array }[] = [];
  for (let entry = await zip.next(); entry; entry = await zip.next()) {
    out.push({ entry, bytes: await zip.readWhole(entry, 1 << 24) });
  }
  await zip.finish();
  return out;
}

Deno.test("crc32 is the zip one", () => {
  assertEquals(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
  assertEquals(crc32(new Uint8Array(0)), 0);
});

Deno.test("a zip reads back entry by entry, stored and deflated, in the order written", async () => {
  const big = Uint8Array.from({ length: 300_000 }, (_, i) => (i >> 7) & 0xff);
  const entries = [
    { name: "a.json", bytes: new TextEncoder().encode("{}"), deflate: false },
    { name: "store/data", bytes: big, deflate: true },
    { name: "empty", bytes: new Uint8Array(0), deflate: true },
  ];
  const file = await writeZip(entries);
  const back = await readAll(file);
  assertEquals(back.map(({ entry }) => entry.name), entries.map((e) => e.name));
  for (const [i, { entry, bytes }] of back.entries()) {
    assertEquals(bytes, entries[i].bytes, entry.name);
    assertEquals(entry.method, entries[i].deflate ? 8 : 0);
  }
  // Deflated, the repetitive entry is far smaller than stored.
  assertEquals(back[1].entry.compressed < big.byteLength / 10, true);
});

Deno.test("each local header carries its sizes and CRC, and the central directory agrees", async () => {
  const bytes = new TextEncoder().encode("hello, zip");
  const file = new Uint8Array(
    await (await writeZip([{ name: "x", bytes, deflate: true }])).arrayBuffer(),
  );
  const view = new DataView(file.buffer);
  assertEquals(view.getUint32(0, true), 0x04034b50);
  assertEquals(view.getUint16(6, true) & 0x8, 0, "no data descriptor");
  assertEquals(view.getUint32(14, true), crc32(bytes));
  assertEquals(view.getUint32(22, true), bytes.byteLength);
  const end = file.byteLength - 22;
  const central = view.getUint32(end + 16, true);
  assertEquals(view.getUint32(central, true), 0x02014b50);
  assertEquals(view.getUint32(central + 16, true), crc32(bytes));
  assertEquals(view.getUint32(central + 42, true), 0, "local header offset");
});

Deno.test("a zip the page did not write that way is refused", async () => {
  const good = new Uint8Array(
    await (await writeZip([{
      name: "x",
      bytes: new Uint8Array(10),
      deflate: false,
    }])).arrayBuffer(),
  );
  const mutate = (at: number, value: number) => {
    const copy = good.slice();
    new DataView(copy.buffer).setUint16(at, value, true);
    return new Blob([copy]);
  };
  await assertRejects(
    () => readAll(mutate(6, 0x8)),
    Error,
    "data descriptor",
  );
  await assertRejects(() => readAll(mutate(8, 93)), Error, "method 93");
  await assertRejects(
    () => readAll(new Blob([good.subarray(0, 35)])),
    Error,
    "truncated",
  );
  await assertRejects(
    () => readAll(new Blob([new Uint8Array(64)])),
    Error,
    "not a zip",
  );
  // Cut in its trailer: every entry reads, the end does not.
  await assertRejects(
    () => readAll(new Blob([good.subarray(0, good.byteLength - 10)])),
    Error,
    "no end of central directory",
  );
  await assertRejects(
    () => readAll(new Blob([good, new Uint8Array(5)])),
    Error,
    "no end of central directory",
  );
});
