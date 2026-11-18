/**
 * Save sandbox and Load sandbox (yurt-playground#8): the running in-tab
 * sandbox as a file the user keeps, and such a file restored in place.
 *
 * The file is the snapshot zip of src/sandbox_snapshot.ts, sealed with no
 * process in it: the sandbox's files and installed packages, not its
 * running programs (the shell and Jupyter start again on it, as after a
 * boot). Save seals the sandbox, hands the zip to the page, and restores
 * the same seal in place, so the session goes on. Load reads and checks
 * the whole file while the running sandbox is untouched -- the zip, its
 * manifest, the build it was saved under, its memory against the device's
 * limit, every entry's CRC-32 -- and only then replaces the sandbox.
 *
 * A loaded file becomes the sandbox: its programs are what runs next.
 * Whether the JS host must validate a seal image from an untrusted source
 * is a kernel question (yurt-playground#8); until it is answered, Load is
 * not deployed.
 */
import type { SandboxSealImage } from "@yurt/kernel-host-interface-js";
import type { Pins } from "./pins.ts";
import type { PageSeal } from "./root_store.ts";
import {
  type SaveKey,
  type SaveKeyScope,
  signBytes,
  verifyBytes,
} from "./save_key.ts";
import {
  type BuiltFrom,
  decodeSandboxSnapshot,
  encodeSandboxSnapshot,
  manifestSigningBytes,
  memoryHasher,
  type SnapshotIdentity,
  snapshotIdentity,
  SnapshotMismatch,
} from "./sandbox_snapshot.ts";

const MIB = 1024 * 1024;
const WASM_PAGE_BYTES = 64 * 1024;

/** The least kernel memory a Load takes: the memory the kernel host
 * starts a kernel with (`KERNEL_INITIAL_PAGES`, 83 pages of 64 KiB, in
 * its kernel_executor_pool.ts), which its restore refuses to shrink. */
export const LOAD_MEMORY_MIN_BYTES = 83 * WASM_PAGE_BYTES;

/** The most kernel memory a Load allocates: the kernel's own maximum
 * (`KERNEL_MAXIMUM_PAGES`, 16,384 pages of 64 KiB, in the kernel's JS
 * host), which a restore could not grow past anyway. */
export const LOAD_MEMORY_MAX_BYTES = 1024 * MIB;

/** The most a phone or tablet page loads: about twice its own snapshot's
 * (241 MiB), so a sandbox with packages installed fits while a file sized
 * for a desktop is refused before it is allocated. */
export const LOAD_MEMORY_MAX_SMALL_BYTES = 512 * MIB;

/** A file Load does not take, said for the user; nothing changed. */
export class LoadRefused extends Error {}

/** Load's refusal of a file this browser did not sign: unsigned, signed
 * elsewhere, or signed with a key this browser no longer has (its site
 * data was cleared). */
export const NOT_SAVED_HERE =
  "This file wasn't saved in this browser (or this site's data was cleared since), so it can't be loaded";

/** The same refusal in a tab whose key is a session one (the site's
 * storage refused or not answering): files saved before, in this browser,
 * cannot be checked here. */
export const NOT_SAVED_IN_TAB =
  "This tab can't use this browser's saved-sandbox key (the site's storage is blocked or not answering), so it loads only files saved in this tab since it was last loaded";

/** What a saved file records it was built from: the page's build. Its
 * packages are its own, so it names no Python set, and a Load asks the
 * live index nothing. */
export function savedBuiltFrom(
  pins: Parameters<typeof snapshotIdentity>[0],
): BuiltFrom {
  return { ...snapshotIdentity(pins), pythonSet: null };
}

/** The download's name, from when it was saved (local time). */
export function savedFileName(at: Date): string {
  const two = (n: number) => String(n).padStart(2, "0");
  return `yurt-sandbox-${at.getFullYear()}-${two(at.getMonth() + 1)}-${
    two(at.getDate())
  }-${two(at.getHours())}${two(at.getMinutes())}.zip`;
}

/** Why a Load refuses kernel memory of `bytes`, or undefined. */
export function memoryRefusal(
  bytes: number,
  smallDevice: boolean,
): string | undefined {
  if (!Number.isSafeInteger(bytes) || bytes <= 0) {
    return `its kernel memory size (${bytes}) is not a size`;
  }
  if (bytes % WASM_PAGE_BYTES !== 0) {
    return `its kernel memory (${bytes} bytes) is not whole 64 KiB pages`;
  }
  if (bytes < LOAD_MEMORY_MIN_BYTES) {
    return `its kernel memory is ${bytes} bytes, under the ${
      (LOAD_MEMORY_MIN_BYTES / MIB).toFixed(1)
    } MiB the kernel starts with`;
  }
  const max = smallDevice ? LOAD_MEMORY_MAX_SMALL_BYTES : LOAD_MEMORY_MAX_BYTES;
  if (bytes > max) {
    return `its kernel memory is ${Math.ceil(bytes / MIB)} MiB, over the ${
      max / MIB
    } MiB ${smallDevice ? "a phone or tablet" : "this page"} loads`;
  }
  return undefined;
}

/** Why a decoded seal is not one a Load restores, or undefined: what the
 * page can check of the host's own fields. A seal with no process (every
 * Save's) has no host wait; scratch the host would adopt lies inside the
 * memory. The kernel state inside the memory is the kernel's question
 * (yurt-playground#8). */
export function sealRefusal(image: SandboxSealImage): string | undefined {
  if (image.processes.length !== 0 || image.hostWaits.length !== 0) {
    return `it holds ${image.processes.length} processes and ${image.hostWaits.length} host waits, not none`;
  }
  const bytes = image.kernelMemory.byteLength;
  const outside = image.executor?.freeScratch.find(({ start, length }) =>
    !Number.isSafeInteger(start) || !Number.isSafeInteger(length) ||
    start < 0 || length < 0 || start + length > bytes
  );
  if (outside !== undefined) {
    return `its executor scratch ${
      JSON.stringify(outside)
    } lies outside its ${bytes} bytes of memory`;
  }
  return undefined;
}

/** The seal image in a file the user picked, read and checked whole --
 * every entry's CRC-32 too, since no pin names its hash -- or
 * {@link LoadRefused} saying why not. A file of another build is refused
 * from its manifest, and one too large for the device before its memory
 * is allocated. Only a kernel whose root is its memory (no YurtFS store)
 * is loaded into. */
export async function decodeLoadedSnapshot(
  body: ReadableStream<Uint8Array<ArrayBuffer>>,
  expected: SnapshotIdentity,
  smallDevice: boolean,
  /** This browser's key (src/save_key.ts): only a file it signed loads,
   * and that is checked before anything else in the file is believed. */
  key: CryptoKey,
): Promise<SandboxSealImage> {
  let image: SandboxSealImage;
  /** The memory's sha256 the signature covers. */
  let signedMemory: string | undefined;
  /** The memory as read, hashed as it comes. */
  const memoryHash = await memoryHasher();
  try {
    image = await decodeSandboxSnapshot(
      body,
      expected,
      undefined,
      (memoryBytes) => {
        const why = memoryRefusal(memoryBytes, smallDevice);
        if (why !== undefined) throw new LoadRefused(`this snapshot: ${why}`);
        return Promise.resolve();
      },
      false,
      true,
      async (manifest) => {
        const tag = manifest.signature;
        if (
          typeof tag !== "string" ||
          typeof manifest.memorySha256 !== "string" ||
          !await verifyBytes(key, manifestSigningBytes(manifest), tag)
        ) {
          throw new LoadRefused(NOT_SAVED_HERE);
        }
        signedMemory = manifest.memorySha256;
      },
      (chunk) => memoryHash.update(chunk),
    );
  } catch (error) {
    if (error instanceof LoadRefused) throw error;
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof SnapshotMismatch && / was built from /.test(message)) {
      throw new LoadRefused(
        "this snapshot was saved by another Yurt build " +
          `(${message.replace(/^.* was built from /, "")}); ` +
          "it loads only on the build that saved it",
      );
    }
    throw new LoadRefused(`not a sandbox snapshot this page loads: ${message}`);
  }
  // The memory is the signed one, byte for byte, before it is restored.
  if (memoryHash.digest("hex") !== signedMemory) {
    throw new LoadRefused(
      "This file was changed after it was saved, so it can't be loaded",
    );
  }
  const why = sealRefusal(image);
  if (why !== undefined) throw new LoadRefused(`this snapshot: ${why}`);
  return image;
}

/** A seal on its way to the restore, which empties it as it takes the
 * image: nothing else holds the (up to 1 GiB) memory once the new kernel
 * has its copy. */
export type SealBox = { image?: PageSeal };

/** How a replace's boot ended: whether a shell came up, and what became
 * of Jupyter there (`none`: a page that starts none, a phone's or
 * tablet's); `error` is the boot's own report, when it made one. */
export type ReplaceOutcome = {
  up: boolean;
  jupyter?: "ready" | "missing" | "failed" | "none";
  error?: string;
};

/** Where a Save or a Load left the page's sandbox: `refused`, untouched;
 * `restored`, the seal is running; `fresh`, the seal did not start and a
 * fresh sandbox did; `none`, neither did. */
export type SandboxOutcome = "refused" | "restored" | "fresh" | "none";

/** What Save and Load report to the page. */
export type SandboxFileMessage =
  | { type: "sandbox-saved"; blob: Blob; name: string }
  // The old sandbox goes now; a boot's reports follow for the new one.
  | { type: "sandbox-replacing"; action: "save" | "load" }
  | {
    type: "sandbox-done";
    action: "save" | "load";
    outcome: SandboxOutcome;
    /** Save: whether the file was handed over. */
    saved?: boolean;
    /** Save: where the key that signed it lives. `session`: storage is
     * refused here, so the file loads only until this tab is closed. */
    keyScope?: SaveKeyScope;
    jupyter?: ReplaceOutcome["jupyter"];
    /** Whatever was not as asked, for the user. */
    why?: string;
    ms: number;
  };

/** Whether the user got what they asked for. */
export function sandboxFileOk(
  done: Extract<SandboxFileMessage, { type: "sandbox-done" }>,
): boolean {
  return done.outcome === "restored" &&
    (done.jupyter === "ready" || done.jupyter === "none") &&
    (done.action === "load" || done.saved === true);
}

/** What Save and Load need from the worker. */
export type SandboxFileDeps = {
  /** This page can replace its sandbox in place: the in-tab one, not a
   * capture's, on a kernel whose root is its memory. */
  canReplace: boolean;
  /** Stop every guest process and seal the running sandbox (it runs
   * nothing more afterwards); undefined when none runs that can.
   * `sealing` is called just before the seal begins, once nothing else
   * (an install) can run first: from there the sandbox is going. */
  seal: ((sealing: () => void) => Promise<PageSeal>) | undefined;
  pins: () => Promise<Pins>;
  /** This origin's save key (src/save_key.ts saveKeys). */
  key: () => Promise<SaveKey>;
  /** A phone or tablet page. */
  smallDevice: boolean;
  /** Drop the running sandbox and start the shell (and Jupyter) on the
   * box's seal as a boot would, taking it out of the box. */
  replace(box: SealBox): Promise<ReplaceOutcome>;
  /** After a sandbox that did not come up: a fresh one, said so; whether
   * its shell came up. */
  startFresh(why: string): Promise<boolean>;
  post(message: SandboxFileMessage): void;
  now?: () => number;
};

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** Exactly one `sandbox-done` per Save or Load, whatever throws. */
async function reported(
  deps: SandboxFileDeps,
  action: "save" | "load",
  run: () => Promise<
    Omit<
      Extract<SandboxFileMessage, { type: "sandbox-done" }>,
      "type" | "action" | "ms"
    >
  >,
): Promise<void> {
  const now = deps.now ?? (() => performance.now());
  const started = now();
  let result: Awaited<ReturnType<typeof run>>;
  try {
    result = await run();
  } catch (error) {
    // Not one of the outcomes run() reports itself: what is running now
    // is unknown, so the user is told to reload.
    result = {
      outcome: "none",
      why: `${errorText(error)}; reload the page for a fresh sandbox`,
    };
  }
  deps.post({
    type: "sandbox-done",
    action,
    ...result,
    ms: Math.round(now() - started),
  });
}

/** A fresh sandbox after one that did not start: `fresh` or `none`. */
async function freshOrNone(
  deps: SandboxFileDeps,
  why: string,
): Promise<SandboxOutcome> {
  try {
    return await deps.startFresh(why) ? "fresh" : "none";
  } catch {
    return "none";
  }
}

/** Replace the sandbox with the box's seal; when no shell comes up on it,
 * a fresh sandbox takes its place. A shell whose Jupyter did not start
 * stays: it is said, not replaced again. */
async function replaceWith(
  deps: SandboxFileDeps,
  box: SealBox,
  what: string,
): Promise<{
  outcome: SandboxOutcome;
  jupyter?: ReplaceOutcome["jupyter"];
  why?: string;
}> {
  let result: ReplaceOutcome;
  try {
    result = await deps.replace(box);
  } catch (error) {
    result = { up: false, error: errorText(error) };
  } finally {
    box.image = undefined;
  }
  if (result.up) {
    return {
      outcome: "restored",
      jupyter: result.jupyter,
      ...(result.jupyter === "missing"
        ? { why: `${what} has no Python set, so Jupyter did not start` }
        : result.jupyter === "failed"
        ? { why: result.error ?? "Jupyter did not start" }
        : {}),
    };
  }
  const why = `${what} did not start${
    result.error === undefined ? "" : `: ${result.error}`
  }`;
  return { outcome: await freshOrNone(deps, why), why };
}

/** Save sandbox: seal, hand the file over, restore the same seal in place.
 * A seal that fails has already stopped the shell and leaves no way back:
 * a fresh sandbox follows, said so. */
export function saveSandbox(deps: SandboxFileDeps): Promise<void> {
  return reported(deps, "save", async () => {
    const seal = deps.seal;
    if (!deps.canReplace || seal === undefined) {
      return { outcome: "refused", why: "this sandbox cannot be saved" };
    }
    // The key first, while the sandbox still runs: a key store that fails
    // or hangs never leaves it sealed.
    let saveKey: SaveKey;
    try {
      saveKey = await deps.key();
    } catch (error) {
      return {
        outcome: "refused",
        why: `no key to sign the file with: ${errorText(error)}`,
      };
    }
    const box: SealBox = {};
    let sealing = false;
    try {
      box.image = await seal(() => {
        sealing = true;
        deps.post({ type: "sandbox-replacing", action: "save" });
      });
    } catch (error) {
      if (!sealing) {
        // Refused before it began: the sandbox is as it was.
        return { outcome: "refused", saved: false, why: errorText(error) };
      }
      const why = `saving failed: ${
        errorText(error)
      }; its shell had already stopped, so a fresh sandbox starts and this one's files are gone`;
      return { outcome: await freshOrNone(deps, why), saved: false, why };
    }
    let saved = false;
    let failed: string | undefined;
    const { key, scope: keyScope } = saveKey;
    try {
      const blob = await encodeSandboxSnapshot(
        box.image,
        savedBuiltFrom(await deps.pins()),
        undefined,
        (bytes) => signBytes(key, bytes),
      );
      deps.post({
        type: "sandbox-saved",
        blob,
        name: savedFileName(new Date()),
      });
      saved = true;
    } catch (error) {
      // Sealed, but no file: the session still comes back on the seal.
      failed = `saving failed: ${errorText(error)}`;
    }
    const back = await replaceWith(deps, box, "the saved sandbox");
    return { ...back, saved, keyScope, why: failed ?? back.why };
  });
}

/** Load sandbox: `file` read and checked whole while the running sandbox
 * is untouched; a refusal changes nothing. Then the sandbox is replaced by
 * it; one that does not come up gives way to a fresh sandbox. */
export function loadSandbox(deps: SandboxFileDeps, file: Blob): Promise<void> {
  return reported(deps, "load", async () => {
    if (!deps.canReplace) {
      return {
        outcome: "refused",
        why: "this page cannot load a sandbox snapshot",
      };
    }
    const box: SealBox = {};
    const { key, scope } = await deps.key();
    try {
      box.image = await decodeLoadedSnapshot(
        file.stream(),
        snapshotIdentity(await deps.pins()),
        deps.smallDevice,
        key,
      );
    } catch (error) {
      const why = errorText(error);
      return {
        outcome: "refused",
        why: scope === "session" && why === NOT_SAVED_HERE
          ? NOT_SAVED_IN_TAB
          : why,
      };
    }
    deps.post({ type: "sandbox-replacing", action: "load" });
    return await replaceWith(deps, box, "the loaded sandbox");
  });
}
