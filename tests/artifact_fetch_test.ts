import { assertEquals, assertRejects } from "@std/assert";
import { fetchPinnedArtifact } from "../src/artifact_fetch.ts";
import { type ArtifactPin, sha256Hex } from "../src/pins.ts";

const url = "/artifact.wasm";
const bytes = new TextEncoder().encode("valid artifact");

function cacheHarness(initial?: Uint8Array) {
  const entries = new Map<string, Response>();
  if (initial !== undefined) {
    entries.set(url, new Response(initial as unknown as BodyInit));
  }
  const cache = {
    match(key: string) {
      return Promise.resolve(entries.get(key)?.clone());
    },
    put(key: string, response: Response) {
      entries.set(key, response.clone());
      return Promise.resolve();
    },
    delete(key: string) {
      return Promise.resolve(entries.delete(key));
    },
  };
  return {
    entries,
    caches: {
      open() {
        return Promise.resolve(cache);
      },
    } as unknown as CacheStorage,
  };
}

async function pinFor(data: Uint8Array): Promise<ArtifactPin> {
  return {
    repo: "test/repo",
    rev: "test",
    build: "test",
    path: url,
    sha256: await sha256Hex(data),
  };
}

Deno.test("pinned fetch uses a valid cache entry and reports completion", async () => {
  const harness = cacheHarness(bytes);
  let calls = 0;
  const progress: Array<{ loaded: number; total?: number }> = [];
  const result = await fetchPinnedArtifact(await pinFor(bytes), {
    url,
    cacheName: "test",
    cacheStorage: harness.caches,
    fetch: () => {
      calls++;
      return Promise.resolve(
        new Response(new Uint8Array() as unknown as BodyInit),
      );
    },
    onProgress: (value) => progress.push(value),
  });
  assertEquals(result, bytes);
  assertEquals(calls, 0);
  assertEquals(progress.at(-1), { loaded: bytes.length, total: bytes.length });
});

Deno.test("pinned fetch discards stale cache and uses verified network bytes", async () => {
  const harness = cacheHarness(new TextEncoder().encode("stale"));
  let calls = 0;
  const result = await fetchPinnedArtifact(await pinFor(bytes), {
    url,
    cacheName: "test",
    cacheStorage: harness.caches,
    fetch: () => {
      calls++;
      return Promise.resolve(new Response(bytes as unknown as BodyInit));
    },
  });
  assertEquals(result, bytes);
  assertEquals(calls, 1);
});

Deno.test("pinned fetch rejects a network hash mismatch", async () => {
  const harness = cacheHarness();
  const pin = await pinFor(bytes);
  await assertRejects(
    () =>
      fetchPinnedArtifact(pin, {
        url,
        cacheName: "test",
        cacheStorage: harness.caches,
        fetch: () =>
          Promise.resolve(
            new Response(
              new TextEncoder().encode("wrong") as unknown as BodyInit,
            ),
          ),
      }),
    Error,
    "sha256 mismatch",
  );
});
