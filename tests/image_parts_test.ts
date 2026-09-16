import { assertEquals, assertRejects } from "@std/assert";
import {
  IMAGE_PART_BYTES,
  imagePartIndex,
  imagePartRange,
  imagePartsManifest,
  partsFetch,
} from "../src/image_parts.ts";
import { handlePlaygroundRequest } from "../src/serve.ts";

Deno.test("image parts cover the file exactly once, each under the Pages cap", () => {
  const size = 2 * IMAGE_PART_BYTES + 12345;
  const manifest = imagePartsManifest("playground.yurtimg", size);
  assertEquals(manifest.parts, [
    "playground.yurtimg.0",
    "playground.yurtimg.1",
    "playground.yurtimg.2",
  ]);
  let next = 0;
  for (const [index] of manifest.parts.entries()) {
    const [start, end] = imagePartRange(index, size)!;
    assertEquals(start, next);
    assertEquals(end - start <= 25 * 1024 * 1024, true);
    next = end;
  }
  assertEquals(next, size);
  assertEquals(imagePartRange(3, size), undefined);
  assertEquals(imagePartsManifest("x", 0).parts, ["x.0"]);
});

Deno.test("part request names parse, everything else does not", () => {
  assertEquals(imagePartIndex("playground.yurtimg.7", "playground.yurtimg"), 7);
  assertEquals(
    imagePartIndex("playground.yurtimg", "playground.yurtimg"),
    undefined,
  );
  assertEquals(
    imagePartIndex("playground.yurtimg.parts.json", "playground.yurtimg"),
    undefined,
  );
  assertEquals(
    imagePartIndex("playgroundXyurtimg.1", "playground.yurtimg"),
    undefined,
  );
});

Deno.test("partsFetch streams the parts in order under the manifest's size", async () => {
  const parts = ["alpha-", "beta-", "gamma"].map((s) =>
    new TextEncoder().encode(s)
  );
  const size = parts.reduce((n, p) => n + p.byteLength, 0);
  const requested: string[] = [];
  const fetchImpl = ((input: RequestInfo | URL) => {
    const url = String(input);
    requested.push(url);
    if (url.endsWith("/img.parts.json")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({ size, parts: ["img.0", "img.1", "img.2"] }),
        ),
      );
    }
    const index = Number(url.slice(-1));
    return Promise.resolve(new Response(parts[index] as unknown as BodyInit));
  }) as typeof fetch;
  const response = await partsFetch(fetchImpl)("http://pg/img");
  assertEquals(response.headers.get("content-length"), String(size));
  assertEquals(
    new TextDecoder().decode(await response.bytes()),
    "alpha-beta-gamma",
  );
  assertEquals(requested, [
    "http://pg/img.parts.json",
    "http://pg/img.0",
    "http://pg/img.1",
    "http://pg/img.2",
  ]);
});

Deno.test("partsFetch surfaces a missing part instead of a short file", async () => {
  const fetchImpl = ((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith(".parts.json")) {
      return Promise.resolve(
        new Response(JSON.stringify({ size: 4, parts: ["img.0", "img.1"] })),
      );
    }
    return Promise.resolve(
      url.endsWith(".0")
        ? new Response(new Uint8Array([1, 2]) as unknown as BodyInit)
        : new Response(null, { status: 404 }),
    );
  }) as typeof fetch;
  const response = await partsFetch(fetchImpl)("http://pg/img");
  await assertRejects(() => response.bytes());
});

Deno.test("the dev server slices its single image into the published parts", async () => {
  const imagePath = new URL("../artifacts/playground.yurtimg", import.meta.url);
  let size: number;
  try {
    size = (await Deno.stat(imagePath)).size;
  } catch {
    if (Deno.env.get("PLAYGROUND_REQUIRE_ARTIFACTS") === "1") {
      throw new Error("pinned artifacts are required but missing");
    }
    console.log("SKIP: pinned image not present");
    return;
  }
  const manifest = await (await handlePlaygroundRequest(
    new Request("http://playground/playground.yurtimg.parts.json"),
  )).json();
  assertEquals(manifest, imagePartsManifest("playground.yurtimg", size));
  const first = await handlePlaygroundRequest(
    new Request("http://playground/playground.yurtimg.0"),
  );
  assertEquals(first.status, 200);
  assertEquals(
    first.headers.get("Cross-Origin-Embedder-Policy"),
    "require-corp",
  );
  const firstBytes = await first.bytes();
  assertEquals(firstBytes.byteLength, Math.min(IMAGE_PART_BYTES, size));
  const file = await Deno.open(imagePath);
  const head = new Uint8Array(16);
  await file.read(head);
  file.close();
  assertEquals(firstBytes.subarray(0, 16), head);
  const beyond = await handlePlaygroundRequest(
    new Request(
      `http://playground/playground.yurtimg.${manifest.parts.length}`,
    ),
  );
  assertEquals(beyond.status, 404);
});

Deno.test("partsFetch reads a part body that is not async-iterable (Safari)", async () => {
  // WebKit ships ReadableStream without Symbol.asyncIterator; `for await`
  // over a part body there throws "undefined is not a function" and the
  // page shows that string instead of a shell.
  const safariBody = (text: string): ReadableStream<Uint8Array> => {
    const stream = new Blob([text]).stream();
    Object.defineProperty(stream, Symbol.asyncIterator, { value: undefined });
    return stream;
  };
  const fetchImpl = ((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith(".parts.json")) {
      return Promise.resolve(
        new Response(JSON.stringify({ size: 6, parts: ["img.0", "img.1"] })),
      );
    }
    return Promise.resolve(
      new Response(safariBody(url.endsWith(".0") ? "abc" : "def")),
    );
  }) as typeof fetch;
  const response = await partsFetch(fetchImpl)("http://pg/img");
  assertEquals(new TextDecoder().decode(await response.bytes()), "abcdef");
});
