#!/usr/bin/env -S deno run --allow-read --allow-net --allow-run --allow-env --allow-write
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startPlaygroundServer } from "../src/serve.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function kernelRoot(): string {
  return Deno.env.get("YURT_KERNEL_ROOT") ??
    join(repoRoot, "../yurtos-kernel");
}

async function ensureBundle(): Promise<void> {
  const kernel = kernelRoot();
  const importMap = {
    imports: {
      "@yurt/kernel-host-interface-js":
        `${kernel}/packages/kernel-host-interface-js/mod.ts`,
      "@yurt/tar-image":
        `${kernel}/packages/runner/src/vfs/tar-image-root-provider.ts`,
      "@xterm/xterm": "npm:@xterm/xterm@5.5.0",
      fzstd: "npm:fzstd@0.1.1",
    },
  };
  const importMapPath = join(repoRoot, "public/import-map.json");
  await Deno.writeTextFile(importMapPath, JSON.stringify(importMap, null, 2));
  await bundle(kernel, {
    entry: join(repoRoot, "src/page.ts"),
    out: join(repoRoot, "public/boot.bundle.js"),
    importMap: importMapPath,
  });
  const coordinatorOut = join(repoRoot, "public/coordinator.bundle.js");
  await bundle(kernel, {
    entry: join(repoRoot, "src/coordinator_worker.ts"),
    out: coordinatorOut,
    importMap: importMapPath,
  });
  // Classic coordinator: import.meta is a syntax error. WorkerHost only
  // uses it to resolve ./worker_bootstrap.ts; location.href is the same.
  await Deno.writeTextFile(
    coordinatorOut,
    (await Deno.readTextFile(coordinatorOut)).replaceAll(
      "import.meta.url",
      "self.location.href",
    ),
  );
  const workerOut = join(repoRoot, "public/worker_bootstrap.ts");
  await bundle(kernel, {
    entry: join(
      kernel,
      "packages/kernel-host-interface-js/kernel-host-interface/worker_bootstrap.ts",
    ),
    out: workerOut,
  });
  // Chrome will not start a nested *module* Worker from a module parent.
  // Classic coordinator + classic guest works. Strip ESM export lists.
  await Deno.writeTextFile(
    workerOut,
    (await Deno.readTextFile(workerOut)).replace(/\nexport \{[\s\S]*$/, "\n"),
  );
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
