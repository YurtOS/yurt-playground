import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  contentSecurityPolicy,
  cspSources,
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

Deno.test("the policy keeps every request on the origin but the models', the packages' and the uploaded snapshots'", () => {
  const policy = contentSecurityPolicy({ scriptHashes: ["'sha256-x'"] });
  assertStringIncludes(policy, "default-src 'self'");
  assertStringIncludes(
    policy,
    "connect-src 'self' https://huggingface.co https://*.hf.co https://openrouter.ai https://raw.githubusercontent.com/YurtOS/yurt-packages/ https://raw.githubusercontent.com/YurtOS/yurt-playground/ https://api.github.com/repos/YurtOS/yurt-playground/git/matching-refs/snapshots/;",
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
    [
      "connect-src 'self' https://huggingface.co https://*.hf.co https://openrouter.ai https://raw.githubusercontent.com/YurtOS/yurt-packages/ https://raw.githubusercontent.com/YurtOS/yurt-playground/ https://api.github.com/repos/YurtOS/yurt-playground/git/matching-refs/snapshots/",
    ],
  );
});

Deno.test("JupyterLite documents reach the origin and the packages path only", () => {
  for (
    const policy of [
      documentPolicy("/jupyter/notebooks/index.html", []),
      contentSecurityPolicy({ sameOriginOnly: true }),
    ]
  ) {
    // On the slim image these pages install Python from the repository
    // before their kernel starts: that one path, and no model host.
    assertEquals(
      policy.split("; ").filter((d) => d.includes("http")),
      [
        "connect-src 'self' https://raw.githubusercontent.com/YurtOS/yurt-packages/",
      ],
    );
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
  assertEquals(
    lines[5].match(/https:\/\/\S+/g),
    ["https://raw.githubusercontent.com/YurtOS/yurt-packages/;"],
  );
  assertEquals(lines.length, 6);
});

Deno.test("the page's privacy note names whoever each connect-src source belongs to", async () => {
  // Every other origin the page may reach, with the analytics beacon on as
  // in production: a new one fails here until the page's note says who it
  // is. README.md's Privacy section says the same, and is kept in step by
  // hand (a test reading Markdown runs in ci.yml's docs-only checks).
  const owners: [RegExp, string][] = [
    [/^https:\/\/(huggingface\.co|\*\.hf\.co)$/, "Hugging Face"],
    [/^https:\/\/openrouter\.ai$/, "OpenRouter"],
    [/^https:\/\/(raw\.githubusercontent\.com|api\.github\.com)\//, "GitHub"],
    [/^https:\/\/cloudflareinsights\.com$/, "Cloudflare"],
  ];
  const html = await Deno.readTextFile(
    new URL("../public/index.html", import.meta.url),
  );
  const start = html.indexOf('data-testid="privacy"');
  const note = html.slice(start, html.indexOf("</section>", start));
  assertEquals(start > 0, true, "the page has a privacy note");
  const sources = cspSources(
    contentSecurityPolicy({ webAnalytics: true }),
    "connect-src",
  ).filter((source) => source !== "'self'");
  assertEquals(sources.length, 7, sources.join(" "));
  for (const source of sources) {
    const owner = owners.find(([pattern]) => pattern.test(source))?.[1];
    assertEquals(owner !== undefined, true, `no owner for ${source}`);
    assertStringIncludes(note, `<strong>${owner}</strong>`, source);
  }
});
