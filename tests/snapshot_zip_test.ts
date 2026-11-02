import { assertEquals, assertRejects } from "@std/assert";
import {
  chunkRanges,
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

Deno.test("a read whose taker fails, or whose entry inflates past its size, settles with that failure and never hangs", async () => {
  let x = 1;
  const bytes = Uint8Array.from(
    { length: 4 << 20 },
    () => (x = (x * 1103515245 + 12345) >>> 0) >>> 24,
  );
  const file = new Uint8Array(
    await (await writeZip([{ name: "m", bytes, deflate: true }]))
      .arrayBuffer(),
  );
  /** `read` of the zip's one entry, or "hung" after 5 s. */
  const outcome = async (
    zipBytes: Uint8Array,
    take: (chunk: Uint8Array) => void,
  ) => {
    // In 64 KiB chunks, as a download arrives.
    let at = 0;
    const zip = new ZipStreamReader(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (at >= zipBytes.byteLength) return controller.close();
          controller.enqueue(zipBytes.slice(at, at += 65536));
        },
      }).getReader(),
    );
    const entry = (await zip.next())!;
    let timer: number | undefined;
    const hung = new Promise<string>((resolve) => {
      timer = setTimeout(() => resolve("hung"), 5000);
    });
    try {
      return await Promise.race([
        zip.read(entry, take).then(
          () => "read",
          (error: Error) => error.message,
        ),
        hung,
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const cases = async (zipBytes: Uint8Array) => {
    // A store write that fails partway (an OPFS quota error).
    assertEquals(
      await outcome(zipBytes, () => {
        throw new Error("quota exceeded");
      }),
      "quota exceeded",
    );
    // A header that claims fewer bytes than the entry inflates to.
    const short = zipBytes.slice();
    new DataView(short.buffer).setUint32(22, 1000, true);
    assertEquals(
      await outcome(short, () => {}),
      "zip entry m inflates past its 1000 bytes",
    );
  };
  await cases(file);
  // Again with compression streams as the Streams spec shapes them: a
  // TransformStream holds back writes nobody reads. Deno's, Chromium's
  // and WebKit's own (de)compression streams do not, so only this shows
  // a reader that waits on its pump after it stopped reading. Identity
  // streams: "deflated" bytes are the bytes.
  const engines = [
    globalThis.CompressionStream,
    globalThis.DecompressionStream,
  ];
  const specShaped = class {
    constructor() {
      return new TransformStream<Uint8Array, Uint8Array>();
    }
  };
  globalThis.CompressionStream =
    specShaped as unknown as typeof CompressionStream;
  globalThis.DecompressionStream =
    specShaped as unknown as typeof DecompressionStream;
  try {
    await cases(
      new Uint8Array(
        await (await writeZip([{ name: "m", bytes, deflate: true }]))
          .arrayBuffer(),
      ),
    );
  } finally {
    [globalThis.CompressionStream, globalThis.DecompressionStream] = engines;
  }
});

Deno.test("an entry is streamed in 1 MiB views up to 4 GiB, past int32 offsets", () => {
  const length = 2.5 * 2 ** 30 + 7;
  const ranges = chunkRanges(length);
  assertEquals(ranges.length, Math.ceil(length / 2 ** 20));
  let at = 0;
  for (const [start, end] of ranges) {
    assertEquals(start, at);
    assertEquals(end > start && end - start <= 2 ** 20, true);
    at = end;
  }
  assertEquals(at, length);
});
