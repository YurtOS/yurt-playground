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
      fzstd: "npm:fzstd@0.1.1",
    },
  };
}

export async function ensureBundle(kernel = kernelRoot()): Promise<void> {
  const { kernelPath, imports } = kernelImportMap(kernel);
  const importMap = { imports };
  const importMapPath = join(repoRoot, "public/import-map.json");
  await Deno.writeTextFile(importMapPath, JSON.stringify(importMap, null, 2));
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
  await Deno.writeTextFile(
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
}

async function bundle(
  kernel: string,
  opts: { entry: string; out: string; importMap?: string },
): Promise<void> {
  const args = ["bundle", "--config", join(kernel, "deno.json")];
  if (opts.importMap) args.push("--import-map", opts.importMap);
  args.push(opts.entry, "-o", opts.out);
  const cmd = new Deno.Command(Deno.execPath(), {
    args,
    cwd: repoRoot,
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stderr } = await cmd.output();
  if (code !== 0) {
    throw new Error(
      `deno bundle ${opts.entry} failed:\n${new TextDecoder().decode(stderr)}`,
    );
  }
}

if (import.meta.main) {
  await ensureBundle();
  const { url } = await startPlaygroundServer(4173);
  console.log(`playground ${url}`);
}
