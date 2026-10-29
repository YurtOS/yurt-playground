#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env --allow-run
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureBundle } from "./serve.ts";
import {
  ISOLATION_HEADERS,
  LITERT_WASM_DIR,
  offeredModelIds,
  XTERM_CSS_PATH,
} from "../src/serve.ts";
import { headersFile, inlineScriptHashes } from "../src/csp.ts";
import {
  imagePartRange,
  imagePartsManifest,
  PYTHON_SEAL_NAME,
} from "../src/image_parts.ts";
import {
  IMAGE_NAME,
  INTEGRITY_FILES,
  integrityManifest,
  SLIM_IMAGE_NAME,
} from "../src/integrity.ts";
import { loadPins, type Pins } from "../src/pins.ts";
import { checkSnapshotFile } from "./lib/snapshot_file.ts";
import {
  pinnedSnapshot,
  SANDBOX_SNAPSHOT_NAME,
  SnapshotMismatch,
} from "../src/sandbox_snapshot.ts";

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
  // The continuous-snapshot demo.
  "snapshot.html",
  "snapshot_page.bundle.js",
  "snapshot.bundle.js",
  "demo/primes.wasm",
  // The suspend/resume notebook kernel (jupyterlite/, `yurt-snapshot`).
  "snapshot-bridge.js",
  "notebook_kernel.bundle.js",
  "demo/cell_server.py",
  "worker_bootstrap.js",
  "playground-bridge.js",
  "verify.js",
  // The page asks whether it is the desktop app; on the hosted site the
  // answer is no, said in JSON rather than as a 404 on every boot (#86).
  "desktop.json",
  "favicon.svg",
  // For pages that name no icon -- JupyterLite's Notebook page -- the
  // browser asks for /favicon.ico; without it, a console 404 (#247).
  "favicon.ico",
  // The local agent's inference worker (#140); its runtime is /llm/.
  "llm_worker.bundle.js",
  "agent.css",
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

async function writeImageParts(
  name: string,
  sourceDir = artifactsDir,
): Promise<void> {
  const image = await Deno.readFile(join(sourceDir, name));
  const manifest = imagePartsManifest(name, image.byteLength);
  const dir = join(distDir, name.slice(0, name.lastIndexOf("/") + 1));
  for (const [index, part] of manifest.parts.entries()) {
    const [start, end] = imagePartRange(index, image.byteLength)!;
    await Deno.writeFile(join(dir, part), image.subarray(start, end));
  }
  await Deno.writeTextFile(
    join(distDir, `${name}.parts.json`),
    JSON.stringify(manifest),
  );
}

/** Whether the sandbox snapshot at `path` is the one `pins` pin, built
 * from the pins' own kernel, image and Python set. One that is not is left
 * out of the site with a loud warning rather than failing the build: it is
 * optional, `?snapshot=1` is the only page that reads it, and that page
 * would refuse it anyway -- after downloading it. */
export async function snapshotMatchesPins(
  path: string,
  pins: Pins,
): Promise<boolean> {
  const leftOut = (why: string) => {
    console.warn(
      `!!! ${SANDBOX_SNAPSHOT_NAME} is NOT published: ${why}. ` +
        "scripts/install-pinned-artifacts.sh fetches the pinned one; " +
        "scripts/release-snapshot.ts captures a new one.",
    );
    return false;
  };
  let pin;
  try {
    pin = pinnedSnapshot(pins);
  } catch (error) {
    if (!(error instanceof SnapshotMismatch)) throw error;
    return leftOut(error.message);
  }
  const check = await checkSnapshotFile(path, pin.builtFrom, {
    sha256: pin.sha256,
  });
  return check.ok || leftOut(check.problem);
}

export async function buildStaticSite(): Promise<void> {
  await ensureBundle(kernelRoot());
  await Deno.remove(distDir, { recursive: true }).catch(() => {});
  await Deno.mkdir(join(distDir, "demo"), { recursive: true });
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
  // The full image stays in the site: with no slim pin, the suspend/resume
  // kernel stages its Python standard library from it (on a slim site it
  // takes it from the set's python package).
  await writeImageParts(IMAGE_NAME);
  // The slim image the browser boots, when the pins name one.
  const slim = await Deno.stat(join(artifactsDir, SLIM_IMAGE_NAME)).then(
    () => true,
    () => false,
  );
  if (slim) await writeImageParts(SLIM_IMAGE_NAME);
  // The notebook kernel's CPython, built into public/ (51 MB): the same.
  // Absent, the `yurt-snapshot` kernel says so at boot; the rest of the
  // site does not need it.
  try {
    await Deno.stat(join(publicDir, PYTHON_SEAL_NAME));
    await writeImageParts(PYTHON_SEAL_NAME, publicDir);
  } catch {
    console.warn(
      `${PYTHON_SEAL_NAME} missing; the yurt-snapshot kernel will not boot (scripts/install-pinned-artifacts.sh)`,
    );
  }
  // The sealed sandbox `?snapshot=1` restores (src/sandbox_snapshot.ts):
  // the pinned one, which scripts/install-pinned-artifacts.sh fetched.
  // Optional; nothing else needs it.
  const snapshotPath = join(publicDir, SANDBOX_SNAPSHOT_NAME);
  const snapshot = await Deno.stat(snapshotPath).then(() => true, () => false);
  const pins = await loadPins(join(artifactsDir, "pins.json"));
  if (!snapshot && pins.snapshot !== undefined) {
    console.warn(
      `${SANDBOX_SNAPSHOT_NAME} is pinned but not here, so not published ` +
        "(YURT_INSTALL_SNAPSHOT=1 scripts/install-pinned-artifacts.sh fetches it)",
    );
  }
  if (snapshot && await snapshotMatchesPins(snapshotPath, pins)) {
    await Deno.mkdir(join(distDir, "snapshot"), { recursive: true });
    await writeImageParts(SANDBOX_SNAPSHOT_NAME, publicDir);
  }
  // The "check the bytes" card hashes what it downloaded against this. dist/
  // holds the image only as parts; hash the file they were sliced from.
  await Deno.writeTextFile(
    join(distDir, "integrity.json"),
    JSON.stringify(
      await integrityManifest(
        (name) =>
          Deno.readFile(
            join(
              name === IMAGE_NAME || name === SLIM_IMAGE_NAME
                ? artifactsDir
                : distDir,
              name,
            ),
          ),
        Deno.env.get("GITHUB_SHA") ?? null,
        slim ? [...INTEGRITY_FILES, SLIM_IMAGE_NAME] : INTEGRITY_FILES,
      ),
      null,
      2,
    ) + "\n",
  );
  await writeLlmRuntime();
  await Deno.writeTextFile(join(distDir, "_headers"), await siteHeaders());
}

/** The local agent's runtime (#140), as the dev server answers it: the
 * model list, LiteRT-LM's glue, and each .wasm gzipped (the largest is
 * 34 MB raw, 10 MB gzipped, and Pages refuses a file over 25 MiB). The
 * weights are not here; the worker downloads them from Hugging Face. */
async function writeLlmRuntime(): Promise<void> {
  const dir = join(distDir, "llm", "wasm");
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(
    join(distDir, "llm", "models.json"),
    JSON.stringify(offeredModelIds()),
  );
  for await (const entry of Deno.readDir(LITERT_WASM_DIR)) {
    const from = join(LITERT_WASM_DIR, entry.name);
    if (entry.name.endsWith(".js")) {
      await Deno.copyFile(from, join(dir, entry.name));
    } else if (entry.name.endsWith(".wasm")) {
      const gz = await new Response(
        (await Deno.open(from)).readable.pipeThrough(
          new CompressionStream("gzip"),
        ),
      ).arrayBuffer();
      if (gz.byteLength > 25 * 2 ** 20) {
        throw new Error(`${entry.name}.gz is over Pages' 25 MiB file limit`);
      }
      await Deno.writeFile(join(dir, `${entry.name}.gz`), new Uint8Array(gz));
    }
  }
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
