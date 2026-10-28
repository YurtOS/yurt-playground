import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  INTEGRITY_FILES,
  sha256Hex,
  SLIM_IMAGE_NAME,
} from "../src/integrity.ts";
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
      "agent.css",
      "favicon.ico",
      "llm_worker.bundle.js",
      "llm/models.json",
      "llm/wasm/litertlm_wasm_internal.js",
      "llm/wasm/litertlm_wasm_internal.wasm.gz",
      "llm/wasm/litertlm_wasm_compat_asyncify_internal.wasm.gz",
    ]
  ) {
    const stat = await Deno.stat(new URL(`dist/${file}`, repoRoot));
    if (stat.size === 0) throw new Error(`dist/${file} is empty`);
  }
  // Notebook 7's commands open tree/, consoles/ and edit/ in new tabs; each is
  // an app the JupyterLite build must emit, or Pages answers with the home
  // page at the wrong path and a Start button that does nothing (#73).
  for (
    const file of [
      "index.html",
      "notebooks/index.html",
      "lab/index.html",
      "tree/index.html",
      "consoles/index.html",
      "edit/index.html",
    ]
  ) {
    const stat = await Deno.stat(new URL(`dist/jupyter/${file}`, repoRoot));
    if (stat.size === 0) throw new Error(`dist/jupyter/${file} is empty`);
  }
  // A 404.html stops Pages' SPA fallback, so a path the site does not have
  // says so instead of serving a broken copy of the home page (#73).
  const notFound = await Deno.readTextFile(new URL("dist/404.html", repoRoot));
  assertStringIncludes(notFound, 'href="/"');
  assertEquals(await inlineScriptHashes(notFound), []);
  // integrity.json hashes the files as they sit in dist/; the image is the
  // exception, published in parts, and the parts check below proves those add
  // back up to the artifact this hash is taken over.
  const integrity = JSON.parse(
    await Deno.readTextFile(new URL("dist/integrity.json", repoRoot)),
  );
  // The slim image is listed when the site ships one.
  const slim = await Deno.stat(
    new URL(`artifacts/${SLIM_IMAGE_NAME}`, repoRoot),
  ).then(() => true, () => false);
  assertEquals(
    Object.keys(integrity.files),
    slim ? [...INTEGRITY_FILES, SLIM_IMAGE_NAME] : [...INTEGRITY_FILES],
  );
  for (const name of INTEGRITY_FILES) {
    const dir = name.endsWith(".yurtimg") ? "artifacts" : "dist";
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
      "connect-src 'self' https://huggingface.co https://*.hf.co https://raw.githubusercontent.com/YurtOS/yurt-packages/;",
      "/jupyter/*\n  ! Content-Security-Policy\n  Content-Security-Policy: ",
    ]
  ) {
    assertStringIncludes(headers, value);
  }
  const [siteRule, jupyterRule] = headers.split("/jupyter/*");
  assertEquals(siteRule.includes("'unsafe-eval'"), false);
  assertEquals(jupyterRule.includes("'unsafe-eval'"), true);
  // The model download is the home page's; JupyterLite stays on the origin.
  assertEquals(jupyterRule.includes("huggingface"), false);
  // The home page ships no inline script, so its rule carries no hash.
  assertEquals(
    await inlineScriptHashes(
      await Deno.readTextFile(new URL("dist/index.html", repoRoot)),
    ),
    [],
  );
  assertEquals(siteRule.includes("'sha256-"), false);
  for (
    const file of [
      "dist/jupyter/notebooks/index.html",
      "dist/jupyter/lab/index.html",
    ]
  ) {
    const hashes = await inlineScriptHashes(
      await Deno.readTextFile(new URL(file, repoRoot)),
    );
    assertEquals(hashes.length > 0, true, `${file} has no inline script`);
    for (const hash of hashes) assertStringIncludes(jupyterRule, hash);
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

Deno.test("the static build publishes a sandbox snapshot only when it is the pinned one, built from the pins", async () => {
  const { snapshotMatchesPins } = await import("../scripts/build-static.ts");
  const { encodeSandboxSnapshot } = await import("../src/sandbox_snapshot.ts");
  const hex = (c: string) => c.repeat(64);
  const pin = (sha256: string) => ({
    repo: "r",
    rev: "v",
    build: "b",
    path: "p",
    sha256,
  });
  const built = {
    kernelSha256: hex("a"),
    kernelRev: "v",
    sealVersion: 1,
    bootSetup: 1,
    imageSha256: hex("b"),
    pythonSealSha256: hex("c"),
    pythonSet: "b/python@3.14.7-yurt_0:0123456789abcdef",
  };
  const seal = {
    version: 1 as const,
    kernelToken: 1n,
    kernelMemory: new Uint8Array(64),
    processes: [],
    hostWaits: [],
    monotonicNs: 0n,
    realtimeOffsetNs: 0n,
    executor: { contexts: [], freeScratch: [] },
  };
  const encode = async (builtFrom: typeof built) =>
    new Uint8Array(
      await (await encodeSandboxSnapshot(seal, builtFrom)).arrayBuffer(),
    );
  const file = await encode(built);
  const pins = {
    kernelWasm: pin(built.kernelSha256),
    image: pin("full"),
    browserImage: pin(built.imageSha256),
    pythonSeal: { sha256: built.pythonSealSha256 },
    snapshot: {
      releaseRepo: "YurtOS/yurt-playground",
      format: 3,
      release: "snapshot-t",
      sha256: await sha256Hex(file),
      size: file.byteLength,
      parts: [await sha256Hex(file)],
      builtFrom: built,
    },
  };
  const dir = await Deno.makeTempDir();
  const warned: unknown[][] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => warned.push(args);
  try {
    const path = `${dir}/sandbox.seal.gz`;
    await Deno.writeFile(path, file);
    assertEquals(await snapshotMatchesPins(path, pins), true);
    assertEquals(warned.length, 0);
    // Not the pinned file (a local capture, an older download).
    const other = await encode({ ...built, imageSha256: hex("d") });
    await Deno.writeFile(path, other);
    assertEquals(await snapshotMatchesPins(path, pins), false);
    assertStringIncludes(String(warned.at(-1)), "not the pinned");
    // The pin itself is of another train's image.
    await Deno.writeFile(path, file);
    assertEquals(
      await snapshotMatchesPins(path, {
        ...pins,
        browserImage: pin(hex("e")),
      }),
      false,
    );
    assertStringIncludes(String(warned.at(-1)), `imageSha256 ${hex("b")}`);
    // No snapshot pinned at all.
    const { snapshot: _snapshot, ...unpinned } = pins;
    assertEquals(await snapshotMatchesPins(path, unpinned), false);
  } finally {
    console.warn = warn;
    await Deno.remove(dir, { recursive: true });
  }
});
