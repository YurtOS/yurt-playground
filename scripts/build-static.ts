#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env --allow-run
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureBundle } from "./serve.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = join(repoRoot, "public");
const artifactsDir = join(repoRoot, "artifacts");
const distDir = join(repoRoot, "dist");

const STATIC_FILES = [
  "index.html",
  "boot.bundle.js",
  "coordinator.bundle.js",
  "worker_bootstrap.js",
  "xterm.css",
];

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

export async function buildStaticSite(): Promise<void> {
  await ensureBundle(kernelRoot());
  await Deno.remove(distDir, { recursive: true }).catch(() => {});
  await Deno.mkdir(distDir, { recursive: true });
  await copyFiles(STATIC_FILES, publicDir, distDir);
  await copyFiles(
    ["yurt_kernel.wasm", "playground.yurtimg"],
    artifactsDir,
    distDir,
  );
  await Deno.writeTextFile(join(distDir, "_headers"), ISOLATION_HEADERS);
}

if (import.meta.main) await buildStaticSite();
