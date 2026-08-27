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

export async function updateLockHash(
  lockPath: string,
  jupyterRoot: string,
): Promise<string> {
  const payload = await existingPayloadRoot(jupyterRoot);
  const treeSha256 = await sha256Bytes(await canonicalTreeTar(payload));
  const lock = JSON.parse(await Deno.readTextFile(lockPath));
  lock.payloadTreeSha256 = treeSha256;
  await Deno.writeTextFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  return treeSha256;
}

if (import.meta.main) {
  const lockPath = Deno.env.get("JUPYTER_LOCK") ??
    join(repoRoot, "artifacts/jupyter-requirements.lock");
  const jupyterRoot = Deno.env.get("YURT_JUPYTER_ROOT") ??
    join(repoRoot, "../yurt-jupyter");
  console.log(await updateLockHash(lockPath, jupyterRoot));
}
