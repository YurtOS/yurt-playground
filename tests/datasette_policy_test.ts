import { assertEquals, assertStringIncludes } from "@std/assert";
import { bridgeErrorResponse, guestResponse } from "../src/datasette_policy.ts";
const hashes = ["sha256-" + "A".repeat(43) + "="];
Deno.test("guest document replaces conflicting policy and carries iframe isolation", async () => {
  const response = guestResponse(
    {
      status: 200,
      headers: [["content-type", "text/html"], [
        "content-security-policy",
        "frame-src 'none'",
      ], ["x-frame-options", "DENY"]],
      body: new TextEncoder().encode("<h1>guest</h1>").buffer,
    },
    "GET",
    hashes,
  );
  assertEquals(
    response.headers.get("cross-origin-embedder-policy"),
    "require-corp",
  );
  assertEquals(
    response.headers.get("cross-origin-opener-policy"),
    "same-origin",
  );
  assertEquals(
    response.headers.get("cross-origin-resource-policy"),
    "same-origin",
  );
  assertEquals(response.headers.get("x-frame-options"), null);
  const csp = response.headers.get("content-security-policy")!;
  assertStringIncludes(csp, "frame-ancestors 'self'");
  assertStringIncludes(csp, "form-action 'self'");
  assertStringIncludes(csp, hashes[0]);
  assertEquals(csp.includes(","), false);
  assertEquals(csp.includes("script-src 'self' 'unsafe-inline'"), false);
  assertEquals(await response.text(), "<h1>guest</h1>");
});
Deno.test("guest assets retain content type and receive isolation headers", () => {
  const response = guestResponse(
    {
      status: 200,
      headers: [["content-type", "application/json"]],
      body: new ArrayBuffer(0),
    },
    "GET",
    hashes,
  );
  assertEquals(response.headers.get("content-type"), "application/json");
  assertEquals(
    response.headers.get("cross-origin-embedder-policy"),
    "require-corp",
  );
});
Deno.test("bridge errors escape diagnostic HTML and prohibit unsupported methods", async () => {
  const response = bridgeErrorResponse(
    405,
    "<script>evil</script>",
    "GET",
    hashes,
  );
  assertEquals(response.headers.get("allow"), "GET, HEAD");
  assertStringIncludes(
    response.headers.get("content-security-policy")!,
    "frame-ancestors 'self'",
  );
  const text = await response.text();
  assertEquals(text.includes("<script>"), false);
  assertStringIncludes(text, "&lt;script&gt;");
});
Deno.test("HEAD errors and bodyless guest replies never acquire a body", async () => {
  assertEquals(
    (await bridgeErrorResponse(503, "no owner", "HEAD", hashes).arrayBuffer())
      .byteLength,
    0,
  );
  for (const status of [204, 304]) {
    assertEquals(
      (await guestResponse(
        {
          status,
          headers: [["content-length", "9"]],
          body: new ArrayBuffer(0),
        },
        "GET",
        hashes,
      ).arrayBuffer()).byteLength,
      0,
    );
  }
});
