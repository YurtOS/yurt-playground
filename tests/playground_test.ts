import { assertEquals } from "@std/assert";
import { handlePlaygroundRequest } from "../src/serve.ts";

// Playwright (`page.goto` + xterm locator) is the browser acceptance
// test. The Deno suite below is the same contract without a browser
// binary: isolation headers, then ash via boot_test.ts.

Deno.test("ash page is served with isolation headers", async () => {
  const res = await handlePlaygroundRequest(new Request("http://playground/"));
  assertEquals(res.headers.get("Cross-Origin-Opener-Policy"), "same-origin");
  assertEquals(
    res.headers.get("Cross-Origin-Embedder-Policy"),
    "require-corp",
  );
  const html = await res.text();
  assertEquals(html.includes('id="term"'), true);
  assertEquals(html.includes("boot.bundle.js"), true);
});
