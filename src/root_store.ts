/**
 * A sealed snapshot of a sandbox whose root filesystem is a YurtFS store
 * (yurtos-kernel#4089) rather than the kernel's ramfs: the store's files
 * then hold the sandbox's files, the kernel's memory only a cache of
 * them, so the snapshot zip carries both (src/sandbox_snapshot.ts) and a
 * restore puts the store back before the memory.
 *
 * {@link RootStoreApi} is what the page needs from the kernel's JS host
 * for that. It does not exist yet -- it is YurtFS's Task 5.4b (the
 * checkpoint binding) and Slice 7 (OPFS) -- so it is written here as the
 * page expects it, and {@link rootStoreOf} finds it on
 * `KernelHostInterface.rootStore` once a kernel has it. Until then it is
 * undefined: a snapshot zip is the kernel memory alone.
 */
import type {
  KernelHostInterface,
  SandboxSealImage,
} from "@yurt/kernel-host-interface-js";
import {
  storeExportOrderProblem,
  type StoreFileName,
  type StoreIdentity,
  type StoreLower,
} from "./pins.ts";

export type { StoreFileName, StoreIdentity, StoreLower };

/** A fresh, empty store the host made for one restore: an OPFS directory
 * in the browser, host files on the desktop. The page fills it from the
 * snapshot zip, in this order, and then has the kernel mount it. */
export interface StoreRestoreTarget {
  /** Stream `image` (a .yurtimg) into `lower.tar`, as the kernel's
   * create mode materializes a lower; its size and sha256, which the
   * store's `meta` records. */
  materializeLower(image: Uint8Array): Promise<StoreLower>;
  /** Write `bytes` at `offset` of `name`: durable in call order, so
   * `meta`, written last, is durable only after the rest. */
  write(name: StoreFileName, offset: number, bytes: Uint8Array): Promise<void>;
  /** Make the copy a complete store (the kernel's `complete_copy`) and
   * read its identity by replay, without mounting it. */
  complete(): Promise<StoreIdentity>;
  /** Remove the copy: a refused restore leaves no store behind. */
  discard(): Promise<void>;
}

export interface RootStoreApi {
  /** A fresh, empty store, with its fixed file set present and empty,
   * claimed by this page from the moment it is made (until its kernel
   * mounts it, or it is discarded). First it removes every store an
   * earlier restore of this page (this origin) left that nothing claims:
   * another tab's root, or a store another tab's restore is still
   * filling, is kept. So stores never outnumber the open tabs plus one;
   * the page also discards a store it restored into when its boot falls
   * back afterwards. */
  freshStore(): Promise<StoreRestoreTarget>;
  /** `host.sealSandbox` with the root store checkpointed under the
   * kernel's barrier: commit and quiesce, then export `data`, the active
   * journal and `meta` (last) through `sink`, each from offset 0 (`bytes`
   * may be reused once it returns). The identity is the one the exported
   * files replay to, the lower the one their `meta` records. */
  sealSandbox(
    host: KernelHostInterface,
    options: {
      sink: (name: StoreFileName, offset: number, bytes: Uint8Array) => void;
    },
  ): Promise<{
    image: SandboxSealImage;
    identity: StoreIdentity;
    lower: StoreLower;
  }>;
  /** `KernelHostInterface.restore` with the root mounted from `target`
   * (completed): refused, before the mount writes anything, when the
   * store's identity is not `expect`. */
  restore(
    kernelWasm: Uint8Array,
    image: SandboxSealImage,
    store: { target: StoreRestoreTarget; expect: StoreIdentity },
    hostState: Parameters<typeof KernelHostInterface.restore>[2],
  ): ReturnType<typeof KernelHostInterface.restore>;
}

/** The kernel host's root store API, when this kernel has one. */
export function rootStoreOf(hostClass: unknown): RootStoreApi | undefined {
  const api = (hostClass as { rootStore?: Partial<RootStoreApi> } | null)
    ?.rootStore;
  return typeof api?.freshStore === "function" &&
      typeof api.sealSandbox === "function" &&
      typeof api.restore === "function"
    ? api as RootStoreApi
    : undefined;
}

/** The store files a seal exported, in export order: each as the chunks
 * the export handed over, never joined (the zip streams them). */
export type SealedStore = {
  identity: StoreIdentity;
  lower: StoreLower;
  files: { name: StoreFileName; bytes: Uint8Array | Uint8Array[] }[];
};

/** A seal the page took: with its root store when the kernel has one. */
export type PageSeal = SandboxSealImage & { rootStore?: SealedStore };

/** Why a store of identity `actual` is not the one `expected`, or
 * undefined. */
export function identityMismatch(
  actual: StoreIdentity,
  expected: StoreIdentity,
): string | undefined {
  const show = (id: StoreIdentity) =>
    `lineage ${id.lineage} sequence ${id.sequence} H ${id.hash}`;
  return actual.lineage === expected.lineage &&
      actual.sequence === expected.sequence && actual.hash === expected.hash
    ? undefined
    : `the store is ${show(actual)}, not ${show(expected)}`;
}

/** Seal `host` through `api`, collecting the store files it exports: each
 * streamed from offset 0 to its end, one after another, in export order. */
export async function sealWithStore(
  api: RootStoreApi,
  host: KernelHostInterface,
): Promise<PageSeal> {
  const files: { name: StoreFileName; bytes: Uint8Array[]; size: number }[] =
    [];
  const sealed = await api.sealSandbox(host, {
    sink: (name, offset, bytes) => {
      let file = files.at(-1);
      if (file?.name !== name) {
        if (files.some((other) => other.name === name)) {
          throw new Error(`the store export went back to ${name}`);
        }
        file = { name, bytes: [], size: 0 };
        files.push(file);
      }
      if (offset !== file.size) {
        throw new Error(
          `the store export wrote ${name} at ${offset}, not at its end ${file.size}`,
        );
      }
      file.bytes.push(bytes.slice());
      file.size += bytes.byteLength;
    },
  });
  // A store with no file data yet has an empty `data`, which an export
  // may never hand the sink at all.
  if (files[0]?.name !== "data") {
    files.unshift({ name: "data", bytes: [], size: 0 });
  }
  const order = storeExportOrderProblem(files.map((file) => file.name));
  if (order !== undefined) throw new Error(`the store export's ${order}`);
  return {
    ...sealed.image,
    rootStore: {
      identity: sealed.identity,
      lower: sealed.lower,
      files: files.map(({ name, bytes }) => ({ name, bytes })),
    },
  };
}
