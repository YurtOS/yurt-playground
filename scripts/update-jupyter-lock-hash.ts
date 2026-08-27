#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env
/**
 * Recompute artifacts/jupyter-requirements.lock's payloadTreeSha256 from the
 * staged yurt-jupyter payload.
 *
 * The hash existed with no producer: every path in the repo verified it and
 * none wrote it, so once the builder environment moved it could not be
 * satisfied or regenerated except by copying a value out of a CI log. Run this
 * against a payload built by the pinned CI environment, and commit the result.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalTreeTar } from "./canonical-tree-tar.ts";
import { existingPayloadRoot, sha256Bytes } from "./materialize-jupyter.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Every .dist-info in the payload, by lowercased package name. */
async function payloadPackages(
  payload: string,
): Promise<Map<string, { version: string; root: string }>> {
  const found = new Map<string, { version: string; root: string }>();
  for await (const entry of walkFiles(payload)) {
    if (!entry.endsWith(".dist-info/METADATA")) continue;
    const text = await Deno.readTextFile(entry);
    const name = text.match(/^Name:\s*(.+)$/mi)?.[1]?.trim();
    const version = text.match(/^Version:\s*(.+)$/mi)?.[1]?.trim();
    if (!name || !version) {
      throw new Error(`invalid package metadata: ${entry}`);
    }
    found.set(name.toLowerCase(), {
      version,
      root: entry.slice(0, -"/METADATA".length),
    });
  }
  return found;
}

async function* walkFiles(root: string): AsyncGenerator<string> {
  for await (const entry of Deno.readDir(root)) {
    const path = `${root}/${entry.name}`;
    if (entry.isDirectory) yield* walkFiles(path);
    else yield path;
  }
}

export async function updateLockHash(
  lockPath: string,
  jupyterRoot: string,
): Promise<string> {
  const payload = await existingPayloadRoot(jupyterRoot);
  const treeSha256 = await sha256Bytes(await canonicalTreeTar(payload));
  // Every hash in the lock describes the same payload, so they all move
  // together: the per-package trees are as build-dependent as the whole.
  const packages = await payloadPackages(payload);
  const text = await Deno.readTextFile(lockPath);
  const lock = JSON.parse(text) as {
    packages: Array<{ name: string; version: string; sha256: string }>;
  };
  let updated = text.replace(
    /("payloadTreeSha256"\s*:\s*")[0-9a-f]{64}(")/,
    `$1${treeSha256}$2`,
  );
  for (const pin of lock.packages) {
    const found = packages.get(pin.name.toLowerCase());
    if (found === undefined) {
      throw new Error(`payload is missing locked package ${pin.name}`);
    }
    const sha256 = await sha256Bytes(await canonicalTreeTar(found.root));
    // Anchor on the recorded hash: package names repeat inside the file.
    updated = updated.replace(pin.sha256, sha256);
  }
  await Deno.writeTextFile(lockPath, updated);
  return treeSha256;
}

if (import.meta.main) {
  const lockPath = Deno.env.get("JUPYTER_LOCK") ??
    join(repoRoot, "artifacts/jupyter-requirements.lock");
  const jupyterRoot = Deno.env.get("YURT_JUPYTER_ROOT") ??
    join(repoRoot, "../yurt-jupyter");
  console.log(await updateLockHash(lockPath, jupyterRoot));
}
