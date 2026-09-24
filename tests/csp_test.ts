import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  contentSecurityPolicy,
  documentPolicy,
  headersFile,
  inlineScriptHashes,
  inlineScripts,
} from "../src/csp.ts";

Deno.test("only executable inline scripts are hashed", () => {
  const html = `
    <script id="jupyter-config-data" type="application/json">{"a":1}</script>
    <script src="./app.js"></script>
    <script>alert(1)</script>
    <script type="module">await import("./x.js");</script>
    <script type="text/javascript">two()</script>
  `;
  assertEquals(inlineScripts(html), [
    "alert(1)",
    'await import("./x.js");',
    "two()",
  ]);
});

Deno.test("inline script hashes are CSP sha256 sources of the exact body", async () => {
  // echo -n 'alert(1)' | openssl dgst -sha256 -binary | base64
  assertEquals(await inlineScriptHashes("<script>alert(1)</script>"), [
    "'sha256-bhHHL3z2vDgxUt0W3dWQOrprscmda2Y5pLsLg4GF+pI='",
  ]);
});

Deno.test("the policy keeps every request on the origin but the model's", () => {
  const policy = contentSecurityPolicy({ scriptHashes: ["'sha256-x'"] });
  assertStringIncludes(policy, "default-src 'self'");
  assertStringIncludes(
    policy,
    "connect-src 'self' https://huggingface.co https://*.hf.co;",
  );
  assertStringIncludes(policy, "frame-src 'none'");
  assertStringIncludes(policy, "object-src 'none'");
  assertStringIncludes(
    policy,
    "script-src 'self' 'wasm-unsafe-eval' 'sha256-x'",
  );
  assertEquals(policy.includes("'unsafe-eval'"), false);
  // Only connect-src names another origin.
  assertEquals(
    policy.split("; ").filter((d) => d.includes("http")),
    ["connect-src 'self' https://huggingface.co https://*.hf.co"],
  );
});

Deno.test("JupyterLite documents stay on the origin alone", () => {
  for (
    const policy of [
      documentPolicy("/jupyter/notebooks/index.html", []),
      contentSecurityPolicy({ sameOriginOnly: true }),
    ]
  ) {
    assertStringIncludes(policy, "connect-src 'self';");
    assertEquals(policy.includes("http"), false);
  }
  assertStringIncludes(
    documentPolicy("/index.html", []),
    "connect-src 'self' https://huggingface.co",
  );
});

Deno.test("only JupyterLite documents may eval", () => {
  assertEquals(
    documentPolicy("/index.html", []).includes("'unsafe-eval'"),
    false,
  );
  assertEquals(
    documentPolicy("/terminal.html", []).includes("'unsafe-eval'"),
    false,
  );
  assertEquals(
    documentPolicy("/jupyter/notebooks/index.html", []).includes(
      "'unsafe-eval'",
    ),
    true,
  );
});

Deno.test("_headers detaches the strict policy before the JupyterLite one", () => {
  const file = headersFile({ "X-A": "1" }, ["'sha256-s'"], ["'sha256-j'"]);
  const lines = file.trimEnd().split("\n");
  assertEquals(lines[0], "/*");
  assertEquals(lines[1], "  X-A: 1");
  assertStringIncludes(lines[2], "Content-Security-Policy: ");
  assertStringIncludes(lines[2], "'sha256-s'");
  assertEquals(lines[2].includes("'unsafe-eval'"), false);
  assertEquals(lines[3], "/jupyter/*");
  assertEquals(lines[4], "  ! Content-Security-Policy");
  assertStringIncludes(lines[5], "'unsafe-eval' 'sha256-j'");
  assertStringIncludes(lines[2], "https://huggingface.co");
  assertEquals(lines[5].includes("http"), false);
  assertEquals(lines.length, 6);
});
