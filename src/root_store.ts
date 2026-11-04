/**
 * A sealed snapshot of a sandbox whose root filesystem is a YurtFS store
 * (yurtos-kernel#4089) rather than the kernel's ramfs: the store's files
 * then hold the sandbox's files, the kernel's memory only a cache of
 * them, so the snapshot zip carries both (src/sandbox_snapshot.ts) and a
 * restore puts the store back before the memory.
 *
 * **{@link ProposedRootStoreApi} is a proposal, pending Sunny's Slice 7
 * design.** No kernel JS host has it: the checkpoint binding is YurtFS
 * Task 5.4b, the browser's store (OPFS) is Slice 7, which waits for
 * #2069 plan 5, and the browser keeps its ramfs root until then. It is
 * written against store format v2 (yurtos-kernel
 * docs/superpowers/specs/2026-11-03-yurtfs-per-inode-storage-amendment.md,
 * merged in #4339): one host file per regular inode (`content/<ino>`),
 * the journals, `meta`, `lower.tar` and `lock`. Its export mirrors the
 * kernel's own (`PackedStore::export`, packages/kernel/src/vfs/packed_store/export.rs,
 * whose v1 form on main hands `(name, offset, bytes)` in 64 KiB pieces;
 * the amendment's section 7 adds `content/<ino>`, skips all-zero pieces
 * and gives each file's length). Everything the page needs from the
 * kernel goes through this one interface, so the real API replaces it
 * here; nothing else in the page names a kernel store call.
 * {@link rootStoreOf} finds it on `KernelHostInterface.rootStore` once a
 * kernel has it. Until then it is undefined: a snapshot zip is the kernel
 * memory alone.
 */
import type {
  KernelHostInterface,
  SandboxSealImage,
} from "@yurt/kernel-host-interface-js";
import type { StoreIdentity, StoreLower } from "./pins.ts";
import {
  type StoreFileName,
  StoreLogWriter,
  type StoreTotals,
} from "./store_log.ts";

export type { StoreFileName, StoreIdentity, StoreLower };

/** Where a store export goes: the kernel's export sink with its length
 * call (the amendment's section 7). Each file's pieces come in order, at
 * offsets that are multiples of 64 KiB (all-zero pieces skipped), then
 * its length; `bytes` may be reused once a call returns. */
export interface StoreExportSink {
  write(name: StoreFileName, offset: number, bytes: Uint8Array): void;
  setLength(name: StoreFileName, length: number): void;
}

/** A fresh, empty store directory the host made for one restore (OPFS in
 * the browser once Slice 7 lands, host files on the desktop). The page
 * fills it from the snapshot zip, in the export's order, and then has the
 * kernel mount it. */
export interface StoreRestoreTarget {
  /** Stream `image` (a .yurtimg) into `lower.tar`, as the kernel's
   * create mode materializes a lower; its size and sha256, which the
   * store's `meta` records. */
  materializeLower(image: Uint8Array): Promise<StoreLower>;
  /** Write `bytes` at `offset` of `name`, creating the file (and
   * `content/`) at its first call. Not a flush per call. `meta` comes
   * last, and only once the snapshot zip passed its hash, so a copy cut
   * short or refused before then holds none. */
  write(name: StoreFileName, offset: number, bytes: Uint8Array): Promise<void>;
  /** Set `name`'s length, creating it when no piece did (an empty or
   * all-zero file). A gap no piece wrote is the host's to keep sparse
   * (the amendment: APFS and ext4 do; OPFS is unmeasured). */
  setLength(name: StoreFileName, length: number): Promise<void>;
  /** Flush every file, `meta` after the rest, make the copy a complete
   * store (the kernel's `complete_copy`: the inactive journal, `lock`,
   * and `content/` if missing), and read its identity by replay, without
   * mounting it. `meta` is written just before this, once the zip passed
   * its hash: a copy cut short or refused earlier holds none, so it is
   * never a store. */
  complete(): Promise<StoreIdentity>;
  /** Remove the copy: a refused restore leaves no store behind. */
  discard(): Promise<void>;
}

/** The proposal: what the page needs from the kernel's JS host for a
 * root store (see the module docs). */
export interface ProposedRootStoreApi {
  /** A fresh, empty store, claimed by this page from the moment it is
   * made (until its kernel mounts it, or it is discarded). First it
   * removes every store an earlier restore of this page (this origin)
   * left that nothing claims: another tab's root, or a store another
   * tab's restore is still filling, is kept. So stores never outnumber
   * the open tabs plus one; the page also discards a store it restored
   * into when its boot falls back afterwards. */
  freshStore(): Promise<StoreRestoreTarget>;
  /** `host.sealSandbox` with the root store checkpointed under the
   * kernel's barrier: commit and quiesce, then export each content file,
   * the active journal and `meta` (last) through `sink`. The identity is
   * the one the exported files replay to, the lower the one their `meta`
   * records. */
  sealSandbox(
    host: KernelHostInterface,
    options: { sink: StoreExportSink },
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
export function rootStoreOf(
  hostClass: unknown,
): ProposedRootStoreApi | undefined {
  const api =
    (hostClass as { rootStore?: Partial<ProposedRootStoreApi> } | null)
      ?.rootStore;
  return typeof api?.freshStore === "function" &&
      typeof api.sealSandbox === "function" &&
      typeof api.restore === "function"
    ? api as ProposedRootStoreApi
    : undefined;
}

/** A seal's store export: its identity and lower, and the log of its
 * sink's calls (src/store_log.ts) as chunks, never joined (the zip
 * streams them), with the files and bytes it names. */
export type SealedStore = StoreTotals & {
  identity: StoreIdentity;
  lower: StoreLower;
  log: Uint8Array[];
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

/** Seal `host` through `api`, writing down the store export it makes
 * (refused unless whole and in the export's order). */
export async function sealWithStore(
  api: ProposedRootStoreApi,
  host: KernelHostInterface,
): Promise<PageSeal> {
  const log = new StoreLogWriter();
  const sealed = await api.sealSandbox(host, {
    sink: {
      write: (name, offset, bytes) => log.write(name, offset, bytes),
      setLength: (name, length) => log.setLength(name, length),
    },
  });
  const totals = log.finish();
  return {
    ...sealed.image,
    rootStore: {
      identity: sealed.identity,
      lower: sealed.lower,
      ...totals,
      log: log.chunks,
    },
  };
}
