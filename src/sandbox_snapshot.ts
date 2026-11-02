/**
 * A sandbox with the Python set already installed, shipped as a sealed
 * kernel (`?snapshot=1`): the page restores it instead of booting the slim
 * image and running `pkg install` (~9,250 files) on every visit.
 *
 * The seal is taken with no guest process alive -- after the install, the
 * shell killed and every helper reaped, before Jupyter -- so the restore
 * brings back no process to rewind: the page then starts its shell and
 * Jupyter on it as after a boot.
 *
 * File: a zip (src/snapshot_zip.ts) of, in this order:
 * - `snapshot.json`, stored: the manifest. What the sandbox was built from
 *   ({@link SnapshotIdentity}; a restore under anything else is refused
 *   before the memory is read), the seal's own fields (bigints written as
 *   `{"$bigint": "<decimal>"}`), and, once the kernel's root is a YurtFS
 *   store, that store's identity and lower (src/root_store.ts);
 * - with a store, `store/data`, `store/journal-a` or `-b`, `store/meta`,
 *   deflated, in the kernel barrier's export order;
 * - `kernel-memory`, deflated.
 * Without a root store the kernel's memory holds the whole filesystem
 * (its ramfs) and the zip holds no store; with one, the memory is only a
 * cache, and a restore writes the store into a fresh one first.
 *
 * The zip is published as a yurt-playground release by
 * scripts/release-snapshot.ts, pinned in artifacts/pins.json (`snapshot`:
 * its one sha256 and what it was built from), fetched into the site by
 * scripts/install-pinned-artifacts.sh, and hashed as the page downloads
 * it.
 */
import { sha256 } from "@noble/hashes/sha2";
import { sha256Hex } from "./integrity.ts";
import { IMAGE_PART_BYTES } from "./image_parts.ts";
import type { SandboxSealImage } from "@yurt/kernel-host-interface-js";
import {
  type BuiltFrom,
  parseStoreIdentity,
  type SnapshotIdentity,
  type SnapshotPin,
  storeExportOrderProblem,
  type StoreFileName,
  type StoreIdentity,
  type StoreLower,
} from "./pins.ts";
import {
  identityMismatch,
  type PageSeal,
  type StoreRestoreTarget,
} from "./root_store.ts";
import {
  buildMismatch,
  FORMAT,
  formatRefusal,
  SEAL_VERSION,
  type SnapshotContents,
  SnapshotMismatch,
  storeRefusal,
} from "./snapshot_pin.ts";
import { writeZip, type ZipEntry, ZipStreamReader } from "./snapshot_zip.ts";

// The pins half, kernel-free (src/snapshot_pin.ts), for this module's
// existing importers. Code the desktop app or the local server loads
// imports src/snapshot_pin.ts itself.
export * from "./snapshot_pin.ts";

/** The host's seal image version is the one this page writes and
 * restores: a host with another version fails the type check here until
 * SEAL_VERSION follows it. */
const _hostSealVersion: SandboxSealImage["version"] = SEAL_VERSION;

const MANIFEST = "snapshot.json";
const MEMORY = "kernel-memory";
const STORE_DIR = "store/";
/** A manifest is a few KiB; anything near this is not one. */
const MANIFEST_MAX = 1 << 20;

/** The store as a snapshot's manifest names it: which one, its lower, and
 * the exported files the zip holds, in order. */
export type ManifestStore = {
  identity: StoreIdentity;
  lower: StoreLower;
  files: StoreFileName[];
};

type Manifest = Omit<SandboxSealImage, "kernelMemory" | "processes"> & {
  format: number;
  builtFrom: BuiltFrom;
  memoryBytes: number;
  /** What it holds; absent in a capture made before it was recorded. */
  contents?: SnapshotContents;
  store?: ManifestStore;
};

function replacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? { $bigint: value.toString() } : value;
}

function reviver(_key: string, value: unknown): unknown {
  if (
    value !== null && typeof value === "object" && "$bigint" in value &&
    Object.keys(value).length === 1
  ) {
    return BigInt((value as { $bigint: string }).$bigint);
  }
  return value;
}

/** The snapshot zip for `image`, a seal with no process in it: with its
 * root store's files when it was taken with them. */
export async function encodeSandboxSnapshot(
  image: PageSeal,
  builtFrom: BuiltFrom,
  contents?: SnapshotContents,
): Promise<Blob> {
  if (image.processes.length !== 0) {
    throw new Error(
      `a sandbox snapshot holds no process; this seal has ${image.processes.length}`,
    );
  }
  const { kernelMemory, processes: _processes, rootStore, ...rest } = image;
  const files = rootStore?.files ?? [];
  const order = storeExportOrderProblem(files.map((file) => file.name));
  if (rootStore !== undefined && order !== undefined) {
    throw new Error(`cannot write the snapshot: ${order}`);
  }
  const manifest: Manifest = {
    ...rest,
    format: FORMAT,
    builtFrom,
    memoryBytes: kernelMemory.byteLength,
    ...(contents === undefined ? {} : { contents }),
    ...(rootStore === undefined ? {} : {
      store: {
        identity: rootStore.identity,
        lower: rootStore.lower,
        files: files.map((file) => file.name),
      },
    }),
  };
  return await writeZip([
    {
      name: MANIFEST,
      bytes: new TextEncoder().encode(JSON.stringify(manifest, replacer)),
      deflate: false,
    },
    ...files.map(({ name, bytes }) => ({
      name: `${STORE_DIR}${name}`,
      bytes,
      deflate: true,
    })),
    { name: MEMORY, bytes: kernelMemory, deflate: true },
  ]);
}

/** Read up to the end of the manifest; the zip's next entries stay in
 * `zip`. */
async function readManifest(zip: ZipStreamReader): Promise<Partial<Manifest>> {
  const entry = await zip.next().catch((error) => {
    // The format of before the zip, refused with its own advice.
    if (error instanceof Error && error.message.endsWith("a gzip, not a zip")) {
      throw new SnapshotMismatch(`sandbox snapshot ${formatRefusal(3)}`);
    }
    throw error;
  });
  if (entry?.name !== MANIFEST) {
    throw new Error(`sandbox snapshot does not begin with ${MANIFEST}`);
  }
  return JSON.parse(
    new TextDecoder().decode(await zip.readWhole(entry, MANIFEST_MAX)),
    reviver,
  );
}

/** A manifest's store, checked, or a throw saying what is wrong. */
function manifestStore(raw: unknown): ManifestStore {
  const fail = (what: string): never => {
    throw new Error(`sandbox snapshot manifest's ${what}`);
  };
  const value = (raw ?? {}) as Record<string, unknown>;
  const lower = (value.lower ?? {}) as Record<string, unknown>;
  if (
    !Number.isInteger(lower.bytes) || (lower.bytes as number) <= 0 ||
    typeof lower.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(lower.sha256)
  ) fail("store.lower must be {bytes, sha256}");
  const files = Array.isArray(value.files) ? value.files.map(String) : [];
  const order = storeExportOrderProblem(files);
  if (order !== undefined) fail(order);
  return {
    identity: parseStoreIdentity(value.identity, fail),
    lower: { bytes: lower.bytes as number, sha256: lower.sha256 as string },
    files: files as StoreFileName[],
  };
}

/** Why a manifest is not one this page restores under `expected`:
 * another format, a store where the kernel has none or none where it has
 * one (`rootStore`; undefined takes either), a malformed store, or
 * another build. */
function manifestMismatch(
  manifest: Partial<Manifest>,
  expected: SnapshotIdentity | BuiltFrom,
  rootStore: boolean | undefined,
): string | undefined {
  const refused = formatRefusal(manifest.format) ??
    storeRefusal(manifest.store !== undefined, rootStore);
  if (refused !== undefined) return `sandbox snapshot ${refused}`;
  if (
    !Number.isInteger(manifest.memoryBytes) || manifest.memoryBytes! < 0
  ) {
    return "sandbox snapshot manifest names no memoryBytes";
  }
  if (manifest.store !== undefined) {
    try {
      manifest.store = manifestStore(manifest.store);
    } catch (error) {
      return (error as Error).message;
    }
  }
  return buildMismatch(manifest.builtFrom, expected);
}

/** The next entry, which must be `name` of `size` bytes uncompressed. */
async function expectEntry(
  zip: ZipStreamReader,
  name: string,
  size?: number,
): Promise<ZipEntry> {
  const entry = await zip.next();
  if (entry?.name !== name) {
    throw new Error(
      `sandbox snapshot holds ${
        entry?.name ?? "no more entries"
      }, not ${name}, next`,
    );
  }
  if (size !== undefined && entry.size !== size) {
    throw new Error(
      `sandbox snapshot's ${name} is ${entry.size} bytes, not the manifest's ${size}`,
    );
  }
  return entry;
}

/** Write the zip's store into `target`, from the entry after the
 * manifest: the lower from the image first, then each exported file in
 * order. Nothing parses them yet: the copy is completed and replayed only
 * once the whole zip passed its hash ({@link decodeSandboxSnapshot}). */
async function restoreStore(
  zip: ZipStreamReader,
  store: ManifestStore,
  target: StoreRestoreTarget,
  image: () => Promise<Uint8Array>,
): Promise<void> {
  const lower = await target.materializeLower(await image());
  if (
    lower.bytes !== store.lower.bytes || lower.sha256 !== store.lower.sha256
  ) {
    throw new SnapshotMismatch(
      `the image materializes to a lower.tar of ${lower.bytes} bytes, sha256 ${lower.sha256}; ` +
        `the snapshot's store was made over ${store.lower.bytes} bytes, sha256 ${store.lower.sha256}`,
    );
  }
  for (const name of store.files) {
    const entry = await expectEntry(zip, `${STORE_DIR}${name}`);
    // An empty file gives no chunk: written once anyway, so it exists.
    if (entry.size === 0) await target.write(name, 0, new Uint8Array(0));
    await zip.read(entry, (chunk, offset) => target.write(name, offset, chunk));
  }
}

/** Skip the zip's store entries (a check that mounts nothing). */
async function skipStore(
  zip: ZipStreamReader,
  store: ManifestStore,
): Promise<void> {
  for (const name of store.files) {
    await zip.read(await expectEntry(zip, `${STORE_DIR}${name}`), () => {});
  }
}

/** A snapshot zip's manifest: what it was built from, read without its
 * memory. Throws {@link SnapshotMismatch} when that is not `expected`
 * (every field it has), or is not for a kernel whose root is (or is not)
 * a store (`rootStore`; undefined takes either). */
export async function checkSandboxSnapshot(
  body: ReadableStream<Uint8Array<ArrayBuffer>>,
  expected: SnapshotIdentity | BuiltFrom,
  rootStore?: boolean,
): Promise<BuiltFrom> {
  const reader = body.getReader();
  try {
    const manifest = await readManifest(new ZipStreamReader(reader));
    const why = manifestMismatch(manifest, expected, rootStore);
    if (why !== undefined) throw new SnapshotMismatch(why);
    return manifest.builtFrom!;
  } finally {
    await reader.cancel().catch(() => {});
  }
}

/** A snapshot zip's manifest facts for its pin: its format, its kernel
 * memory, what it holds (undefined in an older capture) and its store's
 * identity (when it has one). Reads no memory. */
export async function snapshotHeaderFacts(
  body: ReadableStream<Uint8Array<ArrayBuffer>>,
): Promise<{
  format: number;
  memoryBytes: number;
  contents?: SnapshotContents;
  store?: SnapshotPin["store"];
}> {
  const reader = body.getReader();
  try {
    const manifest = await readManifest(new ZipStreamReader(reader));
    if (!Number.isInteger(manifest.memoryBytes)) {
      throw new Error("sandbox snapshot manifest names no memoryBytes");
    }
    if (!Number.isInteger(manifest.format)) {
      throw new Error("sandbox snapshot manifest names no format");
    }
    return {
      format: manifest.format!,
      memoryBytes: manifest.memoryBytes!,
      ...(manifest.contents === undefined
        ? {}
        : { contents: manifest.contents }),
      ...(manifest.store === undefined
        ? {}
        : { store: { identity: manifestStore(manifest.store).identity } }),
    };
  } finally {
    await reader.cancel().catch(() => {});
  }
}

/** Where a restore on a kernel whose root is a store writes the zip's
 * store. */
export type StoreRestore = {
  /** The fresh store to write; the caller discards it on a throw. */
  target: StoreRestoreTarget;
  /** The pin's store identity. */
  expect: StoreIdentity;
  /** The image the store's lower is materialized from. */
  image: () => Promise<Uint8Array>;
};

/** Read a snapshot zip back into a seal image, to the end of the stream
 * (whose own check, the whole file's hash, may still refuse it there). A
 * snapshot not built from `expected` is refused as soon as its manifest
 * is read, before its memory (over 500 MiB) is allocated. `root` says
 * whether the kernel's root is a YurtFS store, and so which zips are
 * taken: false (the default), only one without a store; a
 * {@link StoreRestore}, only one with a store, written into its target
 * first -- a manifest that names another store than the pin's is refused
 * before anything is written, and a written copy that replays to another
 * is refused once the stream ended (so its hash was checked first); true,
 * only one with a store, read but not written (the release tools mount
 * nothing); "either", any. */
export async function decodeSandboxSnapshot(
  body: ReadableStream<Uint8Array<ArrayBuffer>>,
  expected: SnapshotIdentity | BuiltFrom,
  /** Told what the manifest says the snapshot was built from, once it is
   * accepted. */
  onHeader?: (builtFrom: BuiltFrom) => void,
  /** Awaited after the manifest is accepted and before the store or the
   * memory is written: a check that may still refuse the snapshot (the
   * live index's) refuses it before the ~250-545 MiB exist. */
  beforeAllocate?: (memoryBytes: number) => Promise<void>,
  root: StoreRestore | boolean | "either" = false,
  /** Check every entry's CRC-32 too: the release tools' full check, whose
   * file no pinned hash covers yet. */
  checkCrc = false,
): Promise<SandboxSealImage> {
  const store = typeof root === "object" ? root : undefined;
  // A reader, not `for await`: WebKit's ReadableStream is not async-iterable.
  const reader = body.getReader();
  const zip = new ZipStreamReader(reader, { checkCrc });
  try {
    const manifest = await readManifest(zip);
    const why = manifestMismatch(
      manifest,
      expected,
      root === "either" ? undefined : root !== false,
    );
    if (why !== undefined) throw new SnapshotMismatch(why);
    if (store !== undefined) {
      const pinned = identityMismatch(manifest.store!.identity, store.expect);
      if (pinned !== undefined) {
        throw new SnapshotMismatch(`the snapshot's manifest says ${pinned}`);
      }
    }
    onHeader?.(manifest.builtFrom!);
    await beforeAllocate?.(manifest.memoryBytes!);
    if (manifest.store !== undefined) {
      if (store !== undefined) {
        await restoreStore(zip, manifest.store, store.target, store.image);
      } else {
        await skipStore(zip, manifest.store);
      }
    }
    const {
      format: _format,
      builtFrom: _builtFrom,
      memoryBytes,
      contents: _contents,
      store: _store,
      ...seal
    } = manifest as Manifest;
    const entry = await expectEntry(zip, MEMORY, memoryBytes);
    const memory = new Uint8Array(memoryBytes);
    await zip.read(entry, (chunk, offset) => memory.set(chunk, offset));
    if (await zip.next() !== undefined) {
      throw new Error("sandbox snapshot holds an entry after the memory");
    }
    await zip.finish();
    if (store !== undefined) {
      const why = identityMismatch(
        await store.target.complete(),
        manifest.store!.identity,
      );
      if (why !== undefined) {
        throw new SnapshotMismatch(`restoring the snapshot's store: ${why}`);
      }
    }
    return { ...seal, kernelMemory: memory, processes: [] };
  } catch (error) {
    // Whatever is still downloading stops: the source is cancelled.
    await reader.cancel(error).catch(() => {});
    throw error;
  }
}

/** The Cache API store that keeps a snapshot's parts between visits,
 * under the whole zip's sha256: a repeat visit downloads nothing. */
export const SNAPSHOT_PARTS_CACHE = "yurt-playground-snapshot-parts-v2";
/** The gzip snapshot's cache, which nothing reads any more. */
const OLD_PARTS_CACHE = "yurt-playground-snapshot-parts-v1";
const PART_KEY_ORIGIN = "https://yurt-snapshot-parts.invalid/";
/** A cached part's own sha256, as the visit that fetched it computed. */
const PART_SHA256_HEADER = "x-yurt-part-sha256";

/** How many parts are downloaded at once (20 MiB each), so a few, not all
 * of them. */
export const SNAPSHOT_PARTS_IN_FLIGHT = 3;

/** The snapshot zip at `path`, in the parts the site publishes (transport
 * only: Cloudflare Pages refuses a file over 25 MiB), as a stream for
 * {@link decodeSandboxSnapshot}: hashed as it goes, and errored at its end
 * unless it is the pinned size and sha256. Hashed incrementally, never
 * whole: holding the file to hash it at once was more than a Safari tab
 * survives. Up to {@link SNAPSHOT_PARTS_IN_FLIGHT} parts download at once,
 * and the stream gives them in order. With `cache`, each part is kept
 * there under the zip's sha256, and taken from there on a later visit
 * once a whole visit passed the hash; a visit that stops drops the parts
 * it fetched, one that fails the hash drops them all, and once one
 * passes, parts of any other snapshot are dropped. */
export async function fetchVerifiedSnapshot(
  path: string,
  pin: Pick<SnapshotPin, "sha256" | "size">,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  /** Bytes had so far, of the whole file's. */
  onProgress?: (loaded: number, total: number) => void,
  cache?: CacheStorage,
): Promise<ReadableStream<Uint8Array<ArrayBuffer>>> {
  const base = typeof location === "undefined" ? undefined : location.href;
  const manifestUrl = new URL(`${path}.parts.json`, base);
  const manifestResponse = await fetchImpl(manifestUrl);
  if (!manifestResponse.ok) {
    throw new Error(
      `fetch ${path}.parts.json failed: ${manifestResponse.status}`,
    );
  }
  const manifest = await manifestResponse.json() as {
    size: number;
    parts: string[];
  };
  if (manifest.size !== pin.size) {
    throw new Error(
      `${path} is published as ${manifest.size} bytes, not the pinned ${pin.size}`,
    );
  }
  cache?.delete(OLD_PARTS_CACHE).catch(() => {});
  const store = cache === undefined
    ? undefined
    : await cache.open(SNAPSHOT_PARTS_CACHE).catch(() => undefined);
  const giveUp = new AbortController();
  const prefix = `${PART_KEY_ORIGIN}${pin.sha256}/`;
  // The page's own part size too: the site is sliced with it, so parts of
  // another deploy's size are other bytes at an index.
  const keyOf = (at: number) => `${prefix}${IMAGE_PART_BYTES}/${at}`;
  /** Written once the whole zip passed its hash: only then are its cached
   * parts taken. A visit that ends any other way -- a decode that stops, a
   * closed tab -- leaves the parts it fetched untrusted (and drops them
   * when it can); a failed hash drops them all. */
  const verifiedKey = `${prefix}verified`;
  const trusted = await store?.match(verifiedKey).catch(() => undefined) !==
    undefined;
  /** Drop every cached part for which `drop` holds. */
  const dropCached = async (drop: (url: string) => boolean) => {
    if (store === undefined) return;
    for (const request of await store.keys().catch(() => [])) {
      if (drop(request.url)) await store.delete(request).catch(() => {});
    }
  };
  /** The parts this visit put: a visit that stops may have fetched a bad
   * one, while those a verified visit left are as good as they were. */
  const putHere = new Set<string>();
  /** Set once the visit stopped: a part still on its way is not kept. */
  let stopped = false;
  /** The visit ended before the whole zip passed its hash; `all`: it
   * failed the hash, so none of its parts is to be trusted. */
  const forget = (all: boolean) => {
    stopped = true;
    return dropCached((url) => all ? url.startsWith(prefix) : putHere.has(url));
  };
  /** Part `at`: from the cache when a verified zip left it there and it
   * is still the bytes it put (the sha256 it recorded beside them: local
   * integrity, not trust), else fetched (and kept, untrusted until the
   * whole passes). */
  const part = async (at: number): Promise<Uint8Array<ArrayBuffer>> => {
    const cached = trusted
      ? await store?.match(keyOf(at)).catch(() => undefined)
      : undefined;
    if (cached !== undefined) {
      const bytes = new Uint8Array(await cached.arrayBuffer());
      const recorded = cached.headers.get(PART_SHA256_HEADER);
      if (recorded !== null && await sha256Hex(bytes) === recorded) {
        return bytes;
      }
    }
    const name = manifest.parts[at];
    const response = await fetchImpl(new URL(name, manifestUrl), {
      signal: giveUp.signal,
    });
    if (!response.ok) {
      throw new Error(`fetch ${name} failed: ${response.status}`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    putHere.add(keyOf(at));
    if (store !== undefined && !stopped) {
      const headers = { [PART_SHA256_HEADER]: await sha256Hex(bytes) };
      await store.put(keyOf(at), new Response(bytes, { headers }))
        .catch(() => {});
      // The visit stopped meanwhile: its forget() ran before this put.
      if (stopped) await store.delete(keyOf(at)).catch(() => {});
    }
    return bytes;
  };
  const hash = sha256.create();
  const pending: Promise<Uint8Array<ArrayBuffer>>[] = [];
  let asked = 0;
  const askMore = () => {
    while (
      asked < manifest.parts.length &&
      pending.length < SNAPSHOT_PARTS_IN_FLIGHT
    ) {
      const next = part(asked++);
      next.catch(() => {});
      pending.push(next);
    }
  };
  let loaded = 0;
  return new ReadableStream<Uint8Array<ArrayBuffer>>({
    start() {
      askMore();
    },
    async pull(controller) {
      const next = pending.shift();
      if (next === undefined) {
        const actual = [...hash.digest()]
          .map((b) => b.toString(16).padStart(2, "0")).join("");
        if (loaded !== pin.size || actual !== pin.sha256) {
          await forget(true);
          controller.error(
            new Error(
              `sandbox snapshot ${path} is ${loaded} bytes with sha256 ${actual}, ` +
                `not the pinned ${pin.size} bytes with ${pin.sha256}`,
            ),
          );
          return;
        }
        // Before the end is seen, so the cache is settled when it is.
        await store?.put(verifiedKey, new Response("")).catch(() => {});
        // Every other snapshot's parts go, and this one's in another
        // layout (an earlier deploy's part size).
        const keep = new Set([
          verifiedKey,
          ...manifest.parts.map((_, at) => keyOf(at)),
        ]);
        await dropCached((url) => !keep.has(url));
        controller.close();
        return;
      }
      let bytes: Uint8Array<ArrayBuffer>;
      try {
        bytes = await next;
      } catch (error) {
        giveUp.abort(error);
        await forget(false);
        throw error;
      }
      askMore();
      hash.update(bytes);
      loaded += bytes.byteLength;
      onProgress?.(loaded, pin.size);
      controller.enqueue(bytes);
    },
    async cancel(reason) {
      giveUp.abort(reason);
      await forget(false);
    },
  });
}
