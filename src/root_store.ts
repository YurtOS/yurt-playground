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

/** Receives an exported store file's bytes at `offset` (the kernel's
 * `PackedStore::export` sink). Synchronous, as the kernel's export is;
 * `bytes` may be reused once it returns. */
export type StoreExportSink = (
  name: StoreFileName,
  offset: number,
  bytes: Uint8Array,
) => void;

/** A fresh, empty store the host made for one restore: an OPFS directory
 * in the browser, host files on the desktop. The page fills it from the
 * snapshot file, in this order, and then has the kernel mount it. */
export interface StoreRestoreTarget {
  /** Stream `image` (a .yurtimg) into `lower.tar`, as the kernel's
   * create mode materializes a lower; its size and sha256, which the
   * store's `meta` records. */
  materializeLower(image: Uint8Array): Promise<StoreLower>;
  /** Write `bytes` at `offset` of `name`: durable in call order, so
   * `meta`, written last, is durable only after the rest. */
  write(name: StoreFileName, offset: number, bytes: Uint8Array): Promise<void>;
  /** Make the copy a complete store (the kernel's `complete_copy`: the
   * other journal an empty header, `lock` the lineage stamp) and read its
   * identity by replay, without mounting it. */
  complete(): Promise<StoreIdentity>;
  /** Remove the copy: a refused restore leaves no store behind. */
  discard(): Promise<void>;
}

type HostState = Parameters<typeof KernelHostInterface.restore>[2];

export interface RootStoreApi {
  /** A fresh, empty store to restore into. */
  freshStore(): Promise<StoreRestoreTarget>;
  /** `host.sealSandbox` with the root store checkpointed under the
   * kernel's barrier: commit and quiesce, then export `data`, the active
   * journal and `meta` (last) through `sink`. The identity is the one the
   * exported files replay to, the lower the one their `meta` records. */
  sealSandbox(
    host: KernelHostInterface,
    options: { deadlineMs?: number; sink: StoreExportSink },
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
    hostState?: HostState,
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

/** The store files a seal exported, whole, in export order. */
export type SealedStore = {
  identity: StoreIdentity;
  lower: StoreLower;
  files: { name: StoreFileName; bytes: Uint8Array }[];
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
  options: { deadlineMs?: number } = {},
): Promise<PageSeal> {
  const files: { name: StoreFileName; chunks: Uint8Array[]; size: number }[] =
    [];
  const sink: StoreExportSink = (name, offset, bytes) => {
    let file = files.at(-1);
    if (file?.name !== name) {
      if (files.some((other) => other.name === name)) {
        throw new Error(`the store export went back to ${name}`);
      }
      file = { name, chunks: [], size: 0 };
      files.push(file);
    }
    if (offset !== file.size) {
      throw new Error(
        `the store export wrote ${name} at ${offset}, not at its end ${file.size}`,
      );
    }
    file.chunks.push(bytes.slice());
    file.size += bytes.byteLength;
  };
  const sealed = await api.sealSandbox(host, { ...options, sink });
  const order = storeExportOrderProblem(files.map((file) => file.name));
  if (order !== undefined) throw new Error(`the store export's ${order}`);
  return {
    ...sealed.image,
    rootStore: {
      identity: sealed.identity,
      lower: sealed.lower,
      files: files.map(({ name, chunks, size }) => {
        const bytes = new Uint8Array(size);
        let at = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, at);
          at += chunk.byteLength;
        }
        return { name, bytes };
      }),
    },
  };
}
