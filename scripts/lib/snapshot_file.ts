/**
 * The one check of a sandbox snapshot file on disk (src/sandbox_snapshot.ts)
 * that the static build and scripts/release-snapshot.ts share: is this the
 * file to publish or pin?
 */
import { sha256Hex } from "../../src/integrity.ts";
import { loadCatalog, resolveSet } from "../../src/packages.ts";
import type { Pins } from "../../src/pins.ts";
import { pythonInstallRequest } from "../../src/python_install.ts";
import { layerKey } from "../../src/python_layer.ts";
import {
  type BuiltFrom,
  checkSandboxSnapshot,
  decodeSandboxSnapshot,
  type SnapshotIdentity,
} from "../../src/sandbox_snapshot.ts";

export type SnapshotFileCheck =
  | { ok: true; builtFrom: BuiltFrom }
  | { ok: false; problem: string };

/**
 * Whether the file at `path` is a snapshot built from `expected` (every
 * field it has): its header, and -- with `sha256` -- its bytes, and -- with
 * `decode` -- that it inflates to the whole memory its header names. Any
 * failure, a missing file or one that does not inflate included, is a
 * `problem`, never a throw.
 */
export async function checkSnapshotFile(
  path: string,
  expected: SnapshotIdentity | BuiltFrom,
  options: { sha256?: string; decode?: boolean } = {},
): Promise<SnapshotFileCheck> {
  try {
    if (options.sha256 !== undefined) {
      const actual = await sha256Hex(await Deno.readFile(path));
      if (actual !== options.sha256) {
        return {
          ok: false,
          problem: `its sha256 is ${actual}, not the pinned ${options.sha256}`,
        };
      }
    }
    const builtFrom = await checkSandboxSnapshot(
      (await Deno.open(path)).readable,
      expected,
    );
    if (options.decode === true) {
      await decodeSandboxSnapshot((await Deno.open(path)).readable, expected);
    }
    return { ok: true, builtFrom };
  } catch (error) {
    return {
      ok: false,
      problem: error instanceof Deno.errors.NotFound
        ? `${path} is missing`
        : error instanceof Error
        ? error.message
        : String(error),
    };
  }
}

/**
 * The Python set an install under `pins` would get from the live index
 * now, as a layer key -- the form a snapshot's `builtFrom.pythonSet` and
 * the page's liveLayerKey use; null when the pins install no Python (the
 * full image has it). Throws when the index cannot be read.
 */
export async function livePythonSet(
  pins: Pick<Pins, "browserImage">,
): Promise<string | null> {
  const request = pythonInstallRequest(pins);
  if (request === undefined) return null;
  return layerKey(request.image, resolveSet(await loadCatalog(), request.set));
}
