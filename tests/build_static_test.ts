import { assertStringIncludes } from "@std/assert";

Deno.test("static build emits isolated playground deployment", async () => {
  const script = await Deno.readTextFile(
    new URL("../scripts/build-static.ts", import.meta.url),
  );
  for (
    const value of [
      '"dist"',
      '"public"',
      '"artifacts"',
      '"_headers"',
      '"yurt_kernel.wasm"',
      '"playground.yurtimg"',
      '"worker_bootstrap.js"',
      "Cross-Origin-Opener-Policy",
      "Cross-Origin-Embedder-Policy",
      "Cross-Origin-Resource-Policy",
    ]
  ) {
    assertStringIncludes(script, value);
  }
});
