#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env --allow-run
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureBundle } from "./serve.ts";
import { XTERM_CSS_PATH } from "../src/serve.ts";
import { imagePartRange, imagePartsManifest } from "../src/image_parts.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = join(repoRoot, "public");
const artifactsDir = join(repoRoot, "artifacts");
const distDir = join(repoRoot, "dist");

const STATIC_FILES = [
  "index.html",
  "terminal.html",
  "unsupported.html",
  "boot.bundle.js",
  "coordinator.bundle.js",
  "worker_bootstrap.js",
  "playground-bridge.js",
];
/** The JupyterLite site (jupyterlite/build.sh); served under /jupyter/. */
const JUPYTER_DIR = "jupyter";

const ISOLATION_HEADERS = `/*
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp
  Cross-Origin-Resource-Policy: same-origin
`;

function kernelRoot(): string {
  return Deno.env.get("YURT_KERNEL_ROOT") ?? join(repoRoot, "../yurtos-kernel");
}

async function copyFiles(
  files: string[],
  sourceDir: string,
  targetDir: string,
) {
  for (const file of files) {
    await Deno.copyFile(join(sourceDir, file), join(targetDir, file));
  }
}

async function copyTree(source: string, target: string): Promise<void> {
  await Deno.mkdir(target, { recursive: true });
  for await (const entry of Deno.readDir(source)) {
    const from = join(source, entry.name);
    const to = join(target, entry.name);
    if (entry.isDirectory) await copyTree(from, to);
    else await Deno.copyFile(from, to);
  }
}

async function writeImageParts(name: string): Promise<void> {
  const image = await Deno.readFile(join(artifactsDir, name));
  const manifest = imagePartsManifest(name, image.byteLength);
  for (const [index, part] of manifest.parts.entries()) {
    const [start, end] = imagePartRange(index, image.byteLength)!;
    await Deno.writeFile(join(distDir, part), image.subarray(start, end));
  }
  await Deno.writeTextFile(
    join(distDir, `${name}.parts.json`),
    JSON.stringify(manifest),
  );
}

export async function buildStaticSite(): Promise<void> {
  await ensureBundle(kernelRoot());
  await Deno.remove(distDir, { recursive: true }).catch(() => {});
  await Deno.mkdir(distDir, { recursive: true });
  await copyFiles(STATIC_FILES, publicDir, distDir);
  // terminal.html links ./xterm.css; the dev server maps it to the npm package.
  await Deno.copyFile(XTERM_CSS_PATH, join(distDir, "xterm.css"));
  const jupyter = join(publicDir, JUPYTER_DIR);
  try {
    await Deno.stat(join(jupyter, "index.html"));
  } catch {
    throw new Error(
      `JupyterLite site missing at ${jupyter}; run jupyterlite/build.sh`,
    );
  }
  await copyTree(jupyter, join(distDir, JUPYTER_DIR));
  // The page reads the pins for its hash checks, then the blobs.
  await copyFiles(["pins.json", "yurt_kernel.wasm"], artifactsDir, distDir);
  // Cloudflare Pages refuses files over 25 MiB; the image ships in parts.
  await writeImageParts("playground.yurtimg");
  await Deno.writeTextFile(join(distDir, "_headers"), ISOLATION_HEADERS);
}

if (import.meta.main) await buildStaticSite();
