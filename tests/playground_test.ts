import { assertEquals } from "@std/assert";
import { handlePlaygroundRequest } from "../src/serve.ts";

// Deno is the ash contract: isolation headers here, session behavior
// in boot_test.ts via bootPlayground (same kernel + image + PTY).

Deno.test("the terminal address still lands on the workspace, started", async () => {
  const res = await handlePlaygroundRequest(
    new Request("http://playground/terminal.html"),
  );
  assertEquals(res.headers.get("Cross-Origin-Opener-Policy"), "same-origin");
  assertEquals(
    res.headers.get("Cross-Origin-Embedder-Policy"),
    "require-corp",
  );
  const html = await res.text();
  assertEquals(html.includes("url=./?start=1"), true);
  const home = await handlePlaygroundRequest(new Request("http://playground/"));
  const workspace = await home.text();
  assertEquals(workspace.includes('id="term"'), true);
  assertEquals(workspace.includes("boot.bundle.js"), true);
});
