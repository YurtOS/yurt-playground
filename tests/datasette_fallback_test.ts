import { assertEquals, assertStringIncludes } from "@std/assert";
import { handlePlaygroundRequest } from "../src/serve.ts";
Deno.test("direct guest navigation has an isolated strict unavailable document", async () => {
  const response = await handlePlaygroundRequest(
    new Request(
      "http://localhost/apps/datasette/12345678-1234-1234-1234-123456789abc/orders",
    ),
  );
  assertEquals(response.status, 200);
  assertEquals(
    response.headers.get("Cross-Origin-Embedder-Policy"),
    "require-corp",
  );
  assertStringIncludes(
    response.headers.get("Content-Security-Policy")!,
    "frame-src 'none'",
  );
  assertStringIncludes(
    await response.text(),
    "Open Datasette from the playground",
  );
});
