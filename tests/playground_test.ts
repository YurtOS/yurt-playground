import { assertEquals } from "@std/assert";
import { handlePlaygroundRequest } from "../src/serve.ts";

// Deno is the ash contract: isolation headers here, session behavior
// in boot_test.ts via bootPlayground (same kernel + image + PTY).

Deno.test("ash page is served with isolation headers", async () => {
  const res = await handlePlaygroundRequest(
    new Request("http://playground/terminal.html"),
  );
  assertEquals(res.headers.get("Cross-Origin-Opener-Policy"), "same-origin");
  assertEquals(
    res.headers.get("Cross-Origin-Embedder-Policy"),
    "require-corp",
  );
  const html = await res.text();
  assertEquals(html.includes('id="term"'), true);
  assertEquals(html.includes("boot.bundle.js"), true);
});
