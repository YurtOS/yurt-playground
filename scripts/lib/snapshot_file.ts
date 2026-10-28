/**
 * The one check of a sandbox snapshot file on disk (src/sandbox_snapshot.ts)
 * that the static build and scripts/release-snapshot.ts share: is this the
 * file to publish or pin?
 */
import { sha256Hex } from "../../src/integrity.ts";
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
    const body = (await Deno.open(path)).readable;
    if (options.decode !== true) {
      return {
        ok: true,
        builtFrom: await checkSandboxSnapshot(body, expected),
      };
    }
    // Inflated once: the header's verdict comes on the way through.
    let builtFrom: BuiltFrom | undefined;
    await decodeSandboxSnapshot(body, expected, (header) => builtFrom = header);
    return { ok: true, builtFrom: builtFrom! };
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
