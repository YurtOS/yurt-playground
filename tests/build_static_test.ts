import { assertStringIncludes } from "@std/assert";

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
      '"playground.yurtimg"',
      '"worker_bootstrap.js"',
      "Cross-Origin-Opener-Policy",
      "Cross-Origin-Embedder-Policy",
      "Cross-Origin-Resource-Policy",
    ]
  ) {
    assertStringIncludes(script, value);
  }
});

Deno.test("static build writes every file index.html and the page need", async () => {
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
      "boot.bundle.js",
      "coordinator.bundle.js",
      "worker_bootstrap.js",
      "xterm.css",
      "yurt_kernel.wasm",
      "playground.yurtimg",
      "_headers",
    ]
  ) {
    const stat = await Deno.stat(new URL(`dist/${file}`, repoRoot));
    if (stat.size === 0) throw new Error(`dist/${file} is empty`);
  }
});
