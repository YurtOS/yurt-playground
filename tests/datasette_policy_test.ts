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
  assertStringIncludes(
    csp,
    "; sandbox allow-scripts allow-same-origin allow-forms allow-downloads",
  );
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
Deno.test("response headers are an allow-list; explicit drops are reported", () => {
  const dropped: string[] = [];
  const res = guestResponse(
    {
      status: 200,
      headers: [
        ["content-type", "text/plain"],
        ["etag", "x"],
        ["date", "d"],
        ["server", "s"],
        ["refresh", "0;url=/"],
        ["clear-site-data", '"cache"'],
        ["access-control-allow-origin", "*"],
        ["service-worker-allowed", "/"],
        ["content-security-policy", "default-src *"],
        ["x-frame-options", "ALLOW"],
      ],
      body: new ArrayBuffer(0),
    },
    "GET",
    [],
    (h) => dropped.push(h),
  );
  assertEquals(res.headers.get("etag"), "x");
  for (
    const h of [
      "date",
      "server",
      "refresh",
      "clear-site-data",
      "access-control-allow-origin",
      "service-worker-allowed",
      "x-frame-options",
    ]
  ) {
    assertEquals(res.headers.get(h), null, h);
  }
  assertEquals(dropped.sort(), [
    "access-control-allow-origin",
    "clear-site-data",
    "refresh",
    "service-worker-allowed",
  ]);
  assertStringIncludes(
    res.headers.get("content-security-policy")!,
    "script-src 'self'",
  );
});
Deno.test("CSP, nosniff and isolation headers apply to non-HTML responses", () => {
  for (
    const type of [
      "image/svg+xml",
      "application/xhtml+xml",
      "text/javascript",
      "application/json",
    ]
  ) {
    const res = guestResponse(
      {
        status: 200,
        headers: [["content-type", type]],
        body: new ArrayBuffer(0),
      },
      "GET",
      [],
    );
    assertStringIncludes(
      res.headers.get("content-security-policy")!,
      "sandbox allow-scripts allow-same-origin allow-forms allow-downloads",
    );
    assertEquals(res.headers.get("x-content-type-options"), "nosniff");
    assertEquals(
      res.headers.get("cross-origin-resource-policy"),
      "same-origin",
    );
  }
});
Deno.test("bridge errors escape diagnostic HTML and prohibit unsupported methods", async () => {
  const response = bridgeErrorResponse(
    405,
    "<script>evil</script>",
    "GET",
    hashes,
    "Datasette",
  );
  assertEquals(
    response.headers.get("allow"),
    "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS",
  );
  assertStringIncludes(
    response.headers.get("content-security-policy")!,
    "frame-ancestors 'self'",
  );
  const text = await response.text();
  assertEquals(text.includes("<script>"), false);
  assertStringIncludes(text, "&lt;script&gt;");
});
Deno.test("error page names the app", async () => {
  const res = bridgeErrorResponse(503, "down", "GET", [], "Preview <app>");
  const html = await res.text();
  assertStringIncludes(html, "<title>Preview &lt;app&gt; unavailable</title>");
  assertStringIncludes(html, "<h1>Preview &lt;app&gt; unavailable</h1>");
});
Deno.test("HEAD errors and bodyless guest replies never acquire a body", async () => {
  assertEquals(
    (await bridgeErrorResponse(503, "no owner", "HEAD", hashes, "Datasette")
      .arrayBuffer()).byteLength,
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
