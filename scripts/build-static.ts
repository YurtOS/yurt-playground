#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env --allow-run
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureBundle } from "./serve.ts";
import { ISOLATION_HEADERS, XTERM_CSS_PATH } from "../src/serve.ts";
import { headersFile, inlineScriptHashes } from "../src/csp.ts";
import { imagePartRange, imagePartsManifest } from "../src/image_parts.ts";
import { IMAGE_NAME, integrityManifest } from "../src/integrity.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = join(repoRoot, "public");
const artifactsDir = join(repoRoot, "artifacts");
const distDir = join(repoRoot, "dist");

const STATIC_FILES = [
  "index.html",
  "terminal.html",
  "unsupported.html",
  // Its presence stops Cloudflare Pages' SPA fallback: an unknown path gets
  // this and a 404 instead of the home page with assets that do not resolve.
  "404.html",
  "boot.bundle.js",
  "coordinator.bundle.js",
  "worker_bootstrap.js",
  "playground-bridge.js",
  "verify.js",
  // The page asks whether it is the desktop app; on the hosted site the
  // answer is no, said in JSON rather than as a 404 on every boot (#86).
  "desktop.json",
];
/** The JupyterLite site (jupyterlite/build.sh); served under /jupyter/. */
const JUPYTER_DIR = "jupyter";

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
  await writeImageParts(IMAGE_NAME);
  // The "check the bytes" card hashes what it downloaded against this. dist/
  // holds the image only as parts; hash the file they were sliced from.
  await Deno.writeTextFile(
    join(distDir, "integrity.json"),
    JSON.stringify(
      await integrityManifest(
        (name) =>
          Deno.readFile(
            join(name === IMAGE_NAME ? artifactsDir : distDir, name),
          ),
        Deno.env.get("GITHUB_SHA") ?? null,
      ),
      null,
      2,
    ) + "\n",
  );
  await Deno.writeTextFile(join(distDir, "_headers"), await siteHeaders());
}

/** Hash the inline scripts of every HTML file under `dir` (recursively). */
async function scriptHashesUnder(dir: string): Promise<string[]> {
  const hashes = new Set<string>();
  for await (const entry of Deno.readDir(dir)) {
    const path = join(dir, entry.name);
    if (entry.isDirectory) {
      for (const hash of await scriptHashesUnder(path)) hashes.add(hash);
    } else if (entry.name.endsWith(".html")) {
      for (
        const hash of await inlineScriptHashes(await Deno.readTextFile(path))
      ) {
        hashes.add(hash);
      }
    }
  }
  return [...hashes].sort();
}

/** The `_headers` file: isolation plus the CSP, with the inline scripts the
 * built pages actually carry allowed by hash. */
export async function siteHeaders(): Promise<string> {
  const { "Content-Security-Policy": _csp, ...isolation } = ISOLATION_HEADERS;
  const site = new Set<string>();
  for await (const entry of Deno.readDir(distDir)) {
    if (entry.isFile && entry.name.endsWith(".html")) {
      for (
        const hash of await inlineScriptHashes(
          await Deno.readTextFile(join(distDir, entry.name)),
        )
      ) {
        site.add(hash);
      }
    }
  }
  return headersFile(
    isolation,
    [...site].sort(),
    await scriptHashesUnder(join(distDir, JUPYTER_DIR)),
  );
}

if (import.meta.main) await buildStaticSite();
