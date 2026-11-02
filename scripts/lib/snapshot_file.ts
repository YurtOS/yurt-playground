/**
 * The one check of a sandbox snapshot file on disk (src/sandbox_snapshot.ts)
 * that the static build and scripts/release-snapshot.ts share: is this the
 * file to publish or pin?
 */
import { createHash } from "node:crypto";
import { pathToFileURL as toFileUrl } from "node:url";
import { rootStoreOf } from "../../src/root_store.ts";
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
 * field it has): its manifest, and -- with `sha256` -- its bytes, or --
 * with `decode` -- that it inflates to the whole memory its manifest
 * names. With `rootStore`, it must also carry a YurtFS root store (true)
 * or not (false): a zip without one is no snapshot of a kernel whose root
 * is a store. Any failure of the file, a missing one or one that does not
 * inflate included, is a `problem`, never a throw.
 */
export async function checkSnapshotFile(
  path: string,
  expected: SnapshotIdentity | BuiltFrom,
  // One or the other: the hash and a full decode on one read would queue
  // most of the file between them, and inflate a file of the wrong bytes.
  options:
    & ({ sha256?: string; decode?: never } | {
      decode?: boolean;
      sha256?: never;
    })
    & { rootStore?: boolean } = {},
): Promise<SnapshotFileCheck> {
  if (options.sha256 !== undefined && options.decode === true) {
    throw new Error("checkSnapshotFile: a sha256 check or a decode, not both");
  }
  try {
    // One read of the file: the hash (streamed, not the ~131 MB at once)
    // and the header check or decode each take a branch of it.
    let body: ReadableStream<Uint8Array<ArrayBuffer>> =
      (await Deno.open(path)).readable;
    let hashed: Promise<string> | undefined;
    if (options.sha256 !== undefined) {
      const [forHash, forCheck] = body.tee();
      body = forCheck;
      hashed = streamSha256(forHash);
      hashed.catch(() => {});
    }
    let builtFrom: BuiltFrom | undefined;
    let checked: unknown;
    try {
      if (options.decode === true) {
        // Inflated once: the header's verdict comes on the way through.
        await decodeSandboxSnapshot(
          body,
          expected,
          (header) => builtFrom = header,
          undefined,
          options.rootStore ?? "either",
          // The bytes too: the sha256 a release records is the file's own.
          true,
        );
      } else {
        builtFrom = await checkSandboxSnapshot(
          body,
          expected,
          options.rootStore,
        );
      }
    } catch (error) {
      checked = error;
    }
    // The bytes first: a file that is not the pinned one says so.
    if (hashed !== undefined) {
      const actual = await hashed;
      if (actual !== options.sha256) {
        return {
          ok: false,
          problem: `its sha256 is ${actual}, not the pinned ${options.sha256}`,
        };
      }
    }
    if (checked !== undefined) throw checked;
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

/** The sha256 of everything `body` yields, hex, read as it streams. */
async function streamSha256(
  body: ReadableStream<Uint8Array>,
): Promise<string> {
  const hash = createHash("sha256");
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return hash.digest("hex");
    hash.update(value);
  }
}

/** Whether the kernel checkout the page is bundled from (YURT_KERNEL_ROOT,
 * scripts/serve.ts kernelImportMap) has a JS host with a YurtFS root
 * store (src/root_store.ts): every snapshot of it must then carry the
 * store, and none of a kernel without one may. */
export async function kernelRootIsStore(): Promise<boolean> {
  const { kernelImportMap, kernelRoot } = await import("../serve.ts");
  const host = kernelImportMap(kernelRoot()).imports[
    "@yurt/kernel-host-interface-js"
  ];
  const { KernelHostInterface } = await import(toFileUrl(host).href);
  return rootStoreOf(KernelHostInterface) !== undefined;
}
