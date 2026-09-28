import { assert, assertEquals, assertRejects } from "@std/assert";
import { readModel, storeModel } from "../src/llm_store.ts";

/** A Cache that refuses a body over `limit` bytes, as Safari's does over
 * 2 GiB with "Failed writing data to the file system" (#150). */
function limitedCache(limit: number) {
  const entries = new Map<
    string,
    { body: Uint8Array<ArrayBuffer>; headers: Headers }
  >();
  const largest = { bytes: 0 };
  let puts = 0;
  const failAt = {
    put: Infinity,
    key: undefined as string | undefined,
    error: new Error("unused"),
  };
  const cache = {
    async put(key: RequestInfo | URL, response: Response) {
      const body = new Uint8Array(await response.arrayBuffer());
      if (++puts === failAt.put || String(key) === failAt.key) {
        throw failAt.error;
      }
      if (body.byteLength > limit) {
        throw new TypeError("Failed writing data to the file system");
      }
      largest.bytes = Math.max(largest.bytes, body.byteLength);
      entries.set(String(key), { body, headers: response.headers });
    },
    match(key: RequestInfo | URL) {
      const entry = entries.get(String(key));
      return Promise.resolve(
        entry === undefined
          ? undefined
          : new Response(entry.body, { headers: entry.headers }),
      );
    },
    delete(key: RequestInfo | URL) {
      return Promise.resolve(entries.delete(String(key)));
    },
  };
  return { cache: cache as unknown as Cache, entries, largest, failAt };
}

/** `bytes` of a counting pattern, streamed in uneven chunks. */
function model(bytes: number) {
  const data = new Uint8Array(bytes).map((_, i) => (i * 7 + 3) & 0xff);
  let at = 0;
  const body = new ReadableStream<Uint8Array<ArrayBuffer>>({
    pull(controller) {
      if (at >= bytes) return controller.close();
      const n = Math.min(bytes - at, 37 + (at % 91));
      controller.enqueue(data.slice(at, at + n));
      at += n;
    },
  });
  return { data, body };
}

const KEY = "/llm/m.litertlm?sha256=abc";

Deno.test("a model bigger than one cache entry allows is stored in parts and read back whole", async () => {
  const { cache, largest } = limitedCache(1000);
  const { data, body } = model(2500);

  assertEquals(await storeModel(cache, KEY, body, 256), 2500);

  assert(largest.bytes <= 1000, `an entry of ${largest.bytes} bytes`);
  const blob = await readModel(cache, KEY);
  assert(blob !== undefined);
  assertEquals(new Uint8Array(await blob.arrayBuffer()), data);
});

Deno.test("a read chunk several parts long is split, and no put exceeds a part", async () => {
  // A fetch may yield one chunk bigger than a part. Storing all of it as
  // one put would bring back the oversized entry parts exist to avoid.
  const { cache, largest } = limitedCache(1000);
  const data = new Uint8Array(3000).map((_, i) => (i * 13 + 5) & 0xff);
  const sizes = [10, 1100, 30, 900, 960];
  let at = 0;
  const body = new ReadableStream<Uint8Array<ArrayBuffer>>({
    pull(controller) {
      const n = sizes.shift();
      if (n === undefined) return controller.close();
      controller.enqueue(data.slice(at, at + n));
      at += n;
    },
  });

  assertEquals(await storeModel(cache, KEY, body, 256), 3000);

  assert(largest.bytes <= 256, `a put of ${largest.bytes} bytes`);
  const blob = await readModel(cache, KEY);
  assert(blob !== undefined);
  assertEquals(new Uint8Array(await blob.arrayBuffer()), data);
});

Deno.test("a stream without async iteration (Safari 26) is stored", async () => {
  // Safari 26.6.2's ReadableStream has no Symbol.asyncIterator and no
  // values(): `for await (... of body)` threw "undefined is not a function"
  // before a byte was stored (yurt-playground#162 in real Safari).
  const { cache } = limitedCache(1000);
  const { data, body } = model(2500);
  Object.defineProperty(body, Symbol.asyncIterator, { value: undefined });
  Object.defineProperty(body, "values", { value: undefined });

  assertEquals(await storeModel(cache, KEY, body, 256), 2500);

  const blob = await readModel(cache, KEY);
  assert(blob !== undefined);
  assertEquals(new Uint8Array(await blob.arrayBuffer()), data);
});

Deno.test("a download cut short leaves no model behind", async () => {
  const { cache, entries } = limitedCache(1000);
  const { body } = model(2500);
  let sent = 0;
  const cut = body.pipeThrough(
    new TransformStream<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>({
      transform(chunk, controller) {
        sent += chunk.byteLength;
        if (sent > 1200) throw new Error("network gone");
        controller.enqueue(chunk);
      },
    }),
  );

  await assertRejects(() => storeModel(cache, KEY, cut, 256), Error);

  assertEquals([...entries.keys()], [], "the parts written are removed");
  assertEquals(await readModel(cache, KEY), undefined);
});

Deno.test("a quota error mid-write leaves no parts behind", async () => {
  const { cache, entries, failAt } = limitedCache(1000);
  failAt.put = 3;
  failAt.error = new DOMException("quota", "QuotaExceededError");
  const { body } = model(2500);

  await assertRejects(
    () => storeModel(cache, KEY, body, 256),
    DOMException,
    "quota",
  );

  assertEquals([...entries.keys()], []);
});

Deno.test("a quota error on the head entry leaves no parts and no head", async () => {
  // The head goes last, after every part is written: a quota error there
  // left all the parts in the cache with nothing pointing at them.
  const { cache, entries, failAt } = limitedCache(1000);
  failAt.key = KEY;
  failAt.error = new DOMException("quota", "QuotaExceededError");

  await assertRejects(
    () => storeModel(cache, KEY, model(2500).body, 256),
    DOMException,
    "quota",
  );

  assertEquals([...entries.keys()], []);
  assertEquals(await readModel(cache, KEY), undefined);
});

Deno.test("a stored model missing a part reads as absent, to be fetched again", async () => {
  const { cache, entries } = limitedCache(1000);
  await storeModel(cache, KEY, model(2500).body, 256);
  const part = [...entries.keys()].find((k) => k.endsWith("&part=4"));
  assert(part !== undefined);
  entries.delete(part);

  assertEquals(await readModel(cache, KEY), undefined);
});

Deno.test("a model stored whole, before parts, is still read", async () => {
  const { cache } = limitedCache(1000);
  const { data } = model(700);
  await cache.put(KEY, new Response(data));

  const blob = await readModel(cache, KEY);
  assert(blob !== undefined);
  assertEquals(new Uint8Array(await blob.arrayBuffer()), data);
});
