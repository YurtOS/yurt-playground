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
      "@yurt/runner": `${kernel}/packages/runner/src/index.ts`,
      "@yurt/stage-image": `${kernel}/packages/runner/src/vfs-stage.ts`,
      "@xterm/xterm": "npm:@xterm/xterm@5.5.0",
    },
  };
  const importMapPath = join(repoRoot, "public/import-map.json");
  await Deno.writeTextFile(importMapPath, JSON.stringify(importMap, null, 2));
  const cmd = new Deno.Command(Deno.execPath(), {
    args: [
      "bundle",
      "--config",
      join(kernel, "deno.json"),
      "--import-map",
      importMapPath,
      join(repoRoot, "src/boot.ts"),
      "-o",
      join(repoRoot, "public/boot.bundle.js"),
    ],
    cwd: repoRoot,
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stderr } = await cmd.output();
  if (code !== 0) {
    throw new Error(
      `deno bundle boot.ts failed:\n${new TextDecoder().decode(stderr)}`,
    );
  }
}

if (import.meta.main) {
  await ensureBundle();
  const { url } = await startPlaygroundServer(4173);
  console.log(`playground ${url}`);
}
