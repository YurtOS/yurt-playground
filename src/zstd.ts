import { decompress } from "fzstd";

/**
 * Chrome and Deno's DecompressionStream reject `zstd`. The kernel
 * loader then `import("node:zlib")`, which does not exist in the
 * browser and leaves the page stuck on "loading image".
 */
export function decompressYurtimg(bytes: Uint8Array): Uint8Array {
  return decompress(bytes);
}
