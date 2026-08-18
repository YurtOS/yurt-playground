#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env --allow-net
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPins, PinResolutionError, resolveArtifacts } from "../src/pins.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function siblingDefault(name: string): string | undefined {
  const envName = name === "yurtos-kernel"
    ? "YURT_KERNEL_ROOT"
    : "YURT_PORTS_ROOT";
  const fromEnv = Deno.env.get(envName);
  if (fromEnv) return fromEnv;
  const candidates = [
    join(repoRoot, "..", name),
    join(repoRoot, "../..", name),
    join(repoRoot, "../../..", name),
  ];
  for (const candidate of candidates) {
    try {
      if (Deno.statSync(candidate).isDirectory) return candidate;
    } catch {
      // keep looking
    }
  }
  return undefined;
}

if (import.meta.main) {
  try {
    const resolved = await resolveArtifacts({
      artifactsDir: join(repoRoot, "artifacts"),
      pins: await loadPins(join(repoRoot, "artifacts/pins.json")),
      kernelRoot: siblingDefault("yurtos-kernel"),
      portsRoot: siblingDefault("yurt-ports"),
      kernelUrl: Deno.env.get("PLAYGROUND_KERNEL_WASM_URL"),
      imageUrl: Deno.env.get("PLAYGROUND_IMAGE_URL"),
    });
    console.log(
      `pinned ${resolved.source}: ${resolved.kernelWasmPath} ${resolved.imagePath}`,
    );
  } catch (error) {
    const err = error instanceof PinResolutionError
      ? error
      : new PinResolutionError(
        error instanceof Error ? error.message : String(error),
        1,
      );
    console.error(err.message);
    Deno.exit(err.exitCode);
  }
}
