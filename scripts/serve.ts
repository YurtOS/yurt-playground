#!/usr/bin/env -S deno run --allow-read --allow-net --allow-run --allow-env --allow-write
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startPlaygroundServer } from "../src/serve.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

export function resolveKernelRoot(
  root: string,
  base = repoRoot,
): string {
  return resolve(base, root);
}

function kernelRoot(): string {
  return resolveKernelRoot(
    Deno.env.get("YURT_KERNEL_ROOT") ?? "../yurtos-kernel",
  );
}

/**
 * The import map is written to public/, so a relative kernel root would resolve
 * against public/ rather than the repo root. Resolve it here, once, for every
 * caller — the e2e entry points pass the raw YURT_KERNEL_ROOT, and CI sets it
 * to ../yurtos-kernel.
 */
export function kernelImportMap(
  kernelRootInput: string,
): { kernelPath: string; imports: Record<string, string> } {
  const kernelPath = resolveKernelRoot(kernelRootInput);
  return {
    kernelPath,
    imports: {
      "@yurt/kernel-host-interface-js":
        `${kernelPath}/packages/kernel-host-interface-js/mod.ts`,
      "@yurt/tar-image":
        `${kernelPath}/packages/runner/src/vfs/tar-image-root-provider.ts`,
      "@xterm/xterm": "npm:@xterm/xterm@5.5.0",
      "@xterm/addon-fit": "npm:@xterm/addon-fit@0.10.0",
      fzstd: "npm:fzstd@0.1.1",
      "@litert-lm/core": "npm:@litert-lm/core@0.17.1",
    },
  };
}

/**
 * Write via a temp file and rename, so a concurrent reader never sees a
 * half-written bundle: the e2e scripts and the dev server each call
 * ensureBundle and may overlap. Every writer produces the same bytes; the
 * rename only decides which identical copy wins.
 */
async function writeAtomic(path: string, text: string): Promise<void> {
  const tmp = `${path}.${crypto.randomUUID()}.tmp`;
  await Deno.writeTextFile(tmp, text);
  await Deno.rename(tmp, path);
}

export async function ensureBundle(kernel = kernelRoot()): Promise<void> {
  const { kernelPath, imports } = kernelImportMap(kernel);
  const importMap = { imports };
  const importMapPath = join(repoRoot, "public/import-map.json");
  await writeAtomic(importMapPath, JSON.stringify(importMap, null, 2));
  await bundle(kernelPath, {
    entry: join(repoRoot, "src/page.ts"),
    out: join(repoRoot, "public/boot.bundle.js"),
    importMap: importMapPath,
  });
  const coordinatorOut = join(repoRoot, "public/coordinator.bundle.js");
  await bundle(kernelPath, {
    entry: join(repoRoot, "src/coordinator_worker.ts"),
    out: coordinatorOut,
    importMap: importMapPath,
  });
  // Classic coordinator: import.meta is a syntax error. WorkerHost only
  // uses it to resolve ./worker_bootstrap.js; location.href is the same.
  await writeAtomic(
    coordinatorOut,
    (await Deno.readTextFile(coordinatorOut)).replaceAll(
      "import.meta.url",
      "self.location.href",
    ),
  );
  await bundle(kernelPath, {
    entry: join(
      kernelPath,
      "packages/kernel-host-interface-js/kernel-host-interface/worker_bootstrap.ts",
    ),
    out: join(repoRoot, "public/worker_bootstrap.js"),
  });
  // The continuous-snapshot demo (public/snapshot.html): its own page and
  // its own classic coordinator, with the same import.meta rewrite.
  await bundle(kernelPath, {
    entry: join(repoRoot, "src/snapshot_page.ts"),
    out: join(repoRoot, "public/snapshot_page.bundle.js"),
    importMap: importMapPath,
  });
  const snapshotOut = join(repoRoot, "public/snapshot.bundle.js");
  await bundle(kernelPath, {
    entry: join(repoRoot, "src/snapshot_worker.ts"),
    out: snapshotOut,
    importMap: importMapPath,
  });
  await writeAtomic(
    snapshotOut,
    (await Deno.readTextFile(snapshotOut)).replaceAll(
      "import.meta.url",
      "self.location.href",
    ),
  );
  // The JupyterLite Yurt kernel imports this at runtime (see jupyterlite/).
  await bundle(kernelPath, {
    entry: join(repoRoot, "src/lite_bridge.ts"),
    out: join(repoRoot, "public/playground-bridge.js"),
    importMap: importMapPath,
  });
  // The suspend/resume notebook kernel: its bridge (imported by the same
  // extension for the `yurt-snapshot` spec) and its classic coordinator.
  await bundle(kernelPath, {
    entry: join(repoRoot, "src/snapshot_bridge.ts"),
    out: join(repoRoot, "public/snapshot-bridge.js"),
    importMap: importMapPath,
  });
  const notebookKernelOut = join(repoRoot, "public/notebook_kernel.bundle.js");
  await bundle(kernelPath, {
    entry: join(repoRoot, "src/notebook_kernel_worker.ts"),
    out: notebookKernelOut,
    importMap: importMapPath,
  });
  await writeAtomic(
    notebookKernelOut,
    (await Deno.readTextFile(notebookKernelOut)).replaceAll(
      "import.meta.url",
      "self.location.href",
    ),
  );
  // The local agent's inference worker (#140): classic, because LiteRT-LM
  // loads its emscripten glue with importScripts.
  await bundle(kernelPath, {
    entry: join(repoRoot, "src/llm_worker.ts"),
    out: join(repoRoot, "public/llm_worker.bundle.js"),
    importMap: importMapPath,
  });
}

async function bundle(
  kernel: string,
  opts: { entry: string; out: string; importMap?: string },
): Promise<void> {
  const args = ["bundle", "--config", join(kernel, "deno.json")];
  if (opts.importMap) args.push("--import-map", opts.importMap);
  // Bundle to a temp file and rename it into place; see writeAtomic.
  const tmp = `${opts.out}.${crypto.randomUUID()}.tmp`;
  args.push(opts.entry, "-o", tmp);
  const cmd = new Deno.Command(Deno.execPath(), {
    args,
    cwd: repoRoot,
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stderr } = await cmd.output();
  if (code !== 0) {
    await Deno.remove(tmp).catch(() => undefined);
    throw new Error(
      `deno bundle ${opts.entry} failed:\n${new TextDecoder().decode(stderr)}`,
    );
  }
  await Deno.rename(tmp, opts.out);
}

if (import.meta.main) {
  await ensureBundle();
  const { url } = await startPlaygroundServer(4173);
  console.log(`playground ${url}`);
}
