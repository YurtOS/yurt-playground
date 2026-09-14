import { assertEquals } from "@std/assert";
import {
  INTEGRITY_FILES,
  integrityManifest,
  sha256Hex,
} from "../src/integrity.ts";
import { handlePlaygroundRequest } from "../src/serve.ts";

Deno.test("sha256Hex is lowercase hex of the exact bytes", async () => {
  // echo -n 'abc' | shasum -a 256
  assertEquals(
    await sha256Hex(new TextEncoder().encode("abc")),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});

Deno.test("the manifest names every file the sandbox runs on", async () => {
  const manifest = await integrityManifest(
    (name) => Promise.resolve(new TextEncoder().encode(name)),
    "abc123",
  );
  assertEquals(manifest.commit, "abc123");
  assertEquals(Object.keys(manifest.files), [...INTEGRITY_FILES]);
  assertEquals(
    manifest.files["yurt_kernel.wasm"],
    await sha256Hex(new TextEncoder().encode("yurt_kernel.wasm")),
  );
});

Deno.test({
  name: "the dev server's integrity.json matches what it serves",
  ignore: Deno.env.get("PLAYGROUND_REQUIRE_ARTIFACTS") !== "1",
  fn: async () => {
    const res = await handlePlaygroundRequest(
      new Request("http://127.0.0.1/integrity.json"),
    );
    assertEquals(res.status, 200);
    const manifest = await res.json();
    assertEquals(manifest.commit, null);
    for (const name of INTEGRITY_FILES) {
      const file = await handlePlaygroundRequest(
        new Request(`http://127.0.0.1/${name}`),
      );
      assertEquals(file.status, 200, name);
      assertEquals(
        manifest.files[name],
        await sha256Hex(new Uint8Array(await file.arrayBuffer())),
        name,
      );
    }
  },
});
