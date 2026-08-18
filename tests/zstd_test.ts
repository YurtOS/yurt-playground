import { assertEquals } from "@std/assert";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { decompressYurtimg } from "../src/zstd.ts";

const repoRoot = join(fileURLToPath(import.meta.url), "../..");

Deno.test("decompressYurtimg unpacks a zstd yurtimg without node:zlib", async () => {
  let img: Uint8Array;
  try {
    img = await Deno.readFile(join(repoRoot, "artifacts/playground.yurtimg"));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      console.log("skipping zstd artifact test: playground.yurtimg is absent");
      return;
    }
    throw error;
  }
  assertEquals(img[0], 0x28);
  assertEquals(img[1], 0xb5);
  assertEquals(img[2], 0x2f);
  assertEquals(img[3], 0xfd);
  const tar = decompressYurtimg(img);
  assertEquals(new TextDecoder().decode(tar.subarray(257, 262)), "ustar");
});
