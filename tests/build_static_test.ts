import { assertEquals, assertStringIncludes } from "@std/assert";
import { INTEGRITY_FILES, sha256Hex } from "../src/integrity.ts";
import { inlineScriptHashes } from "../src/csp.ts";

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
      "IMAGE_NAME",
      '"worker_bootstrap.js"',
      "ISOLATION_HEADERS",
      "headersFile",
    ]
  ) {
    assertStringIncludes(script, value);
  }
});

Deno.test("static build writes every file the pages need", async () => {
  // The script used to copy public/xterm.css, which never existed: the dev
  // server maps /xterm.css to the npm package. Exercise the build itself so a
  // missing input fails here, not in the deploy job.
  const repoRoot = new URL("..", import.meta.url);
  const artifacts = ["yurt_kernel.wasm", "playground.yurtimg"].map((name) =>
    new URL(`artifacts/${name}`, repoRoot)
  );
  const haveArtifacts = artifacts.every((url) => {
    try {
      return Deno.statSync(url).isFile;
    } catch {
      return false;
    }
  });
  if (!haveArtifacts) {
    if (Deno.env.get("PLAYGROUND_REQUIRE_ARTIFACTS") === "1") {
      throw new Error("pinned artifacts are required but missing");
    }
    console.log("SKIP: pinned artifacts not present");
    return;
  }
  const { buildStaticSite } = await import("../scripts/build-static.ts");
  await buildStaticSite();
  for (
    const file of [
      "index.html",
      "terminal.html",
      "unsupported.html",
      "boot.bundle.js",
      "coordinator.bundle.js",
      "worker_bootstrap.js",
      "xterm.css",
      "pins.json",
      "yurt_kernel.wasm",
      "playground.yurtimg.parts.json",
      "_headers",
      "verify.js",
      "integrity.json",
    ]
  ) {
    const stat = await Deno.stat(new URL(`dist/${file}`, repoRoot));
    if (stat.size === 0) throw new Error(`dist/${file} is empty`);
  }
  for (const file of ["index.html", "notebooks/index.html", "lab/index.html"]) {
    const stat = await Deno.stat(new URL(`dist/jupyter/${file}`, repoRoot));
    if (stat.size === 0) throw new Error(`dist/jupyter/${file} is empty`);
  }
  // integrity.json hashes the files as they sit in dist/; the image is the
  // exception, published in parts, and the parts check below proves those add
  // back up to the artifact this hash is taken over.
  const integrity = JSON.parse(
    await Deno.readTextFile(new URL("dist/integrity.json", repoRoot)),
  );
  assertEquals(Object.keys(integrity.files), [...INTEGRITY_FILES]);
  for (const name of INTEGRITY_FILES) {
    const dir = name === "playground.yurtimg" ? "artifacts" : "dist";
    assertEquals(
      integrity.files[name],
      await sha256Hex(await Deno.readFile(new URL(`${dir}/${name}`, repoRoot))),
      name,
    );
  }
  // The deployed headers carry the isolation trio and both CSP rules, with
  // every built page's inline scripts allowed by hash (the JupyterLite
  // bootstraps change hash with each build, so they are derived, not typed).
  const headers = await Deno.readTextFile(new URL("dist/_headers", repoRoot));
  for (
    const value of [
      "Cross-Origin-Opener-Policy: same-origin",
      "Cross-Origin-Embedder-Policy: require-corp",
      "Cross-Origin-Resource-Policy: same-origin",
      "connect-src 'self'",
      "/jupyter/*\n  ! Content-Security-Policy\n  Content-Security-Policy: ",
    ]
  ) {
    assertStringIncludes(headers, value);
  }
  const [siteRule, jupyterRule] = headers.split("/jupyter/*");
  assertEquals(siteRule.includes("'unsafe-eval'"), false);
  assertEquals(jupyterRule.includes("'unsafe-eval'"), true);
  for (
    const [rule, file] of [
      [siteRule, "dist/index.html"],
      [jupyterRule, "dist/jupyter/notebooks/index.html"],
      [jupyterRule, "dist/jupyter/lab/index.html"],
    ] as const
  ) {
    const hashes = await inlineScriptHashes(
      await Deno.readTextFile(new URL(file, repoRoot)),
    );
    assertEquals(hashes.length > 0, true, `${file} has no inline script`);
    for (const hash of hashes) assertStringIncludes(rule, hash);
  }
  // Cloudflare Pages refuses any file over 25 MiB (deploy run 34841044263
  // died on the 86.9 MB image), so the image ships in parts that add back
  // up to the pinned blob byte for byte.
  const manifest = JSON.parse(
    await Deno.readTextFile(
      new URL("dist/playground.yurtimg.parts.json", repoRoot),
    ),
  ) as { size: number; parts: string[] };
  const image = await Deno.readFile(
    new URL("artifacts/playground.yurtimg", repoRoot),
  );
  assertEquals(manifest.size, image.byteLength);
  let offset = 0;
  for (const part of manifest.parts) {
    const bytes = await Deno.readFile(new URL(`dist/${part}`, repoRoot));
    assertEquals(
      bytes.byteLength <= 25 * 1024 * 1024,
      true,
      `${part} exceeds the Pages cap`,
    );
    assertEquals(bytes, image.subarray(offset, offset + bytes.byteLength));
    offset += bytes.byteLength;
  }
  assertEquals(offset, image.byteLength);
  for await (const entry of Deno.readDir(new URL("dist", repoRoot))) {
    const stat = await Deno.stat(new URL(`dist/${entry.name}`, repoRoot));
    assertEquals(
      stat.size <= 25 * 1024 * 1024,
      true,
      `dist/${entry.name} exceeds the Pages cap`,
    );
  }
});
