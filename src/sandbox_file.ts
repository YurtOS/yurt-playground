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
  type BuiltFrom,
  decodeSandboxSnapshot,
  encodeSandboxSnapshot,
  type SnapshotIdentity,
  snapshotIdentity,
  SnapshotMismatch,
} from "./sandbox_snapshot.ts";

const MIB = 1024 * 1024;
const WASM_PAGE_BYTES = 64 * 1024;

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
  const max = smallDevice ? LOAD_MEMORY_MAX_SMALL_BYTES : LOAD_MEMORY_MAX_BYTES;
  if (bytes > max) {
    return `its kernel memory is ${Math.ceil(bytes / MIB)} MiB, over the ${
      max / MIB
    } MiB ${smallDevice ? "a phone or tablet" : "this page"} loads`;
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
): Promise<SandboxSealImage> {
  try {
    return await decodeSandboxSnapshot(
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
}

/** What Save and Load report to the page. `changed`: the sandbox was
 * replaced (a refusal leaves it as it was). */
export type SandboxFileMessage =
  | { type: "sandbox-saved"; blob: Blob; name: string; ms: number }
  // The old sandbox goes now; a boot's reports follow for the new one.
  | { type: "sandbox-replacing"; action: "save" | "load" }
  | {
    type: "sandbox-done";
    action: "save" | "load";
    ok: boolean;
    changed: boolean;
    why?: string;
    ms: number;
  };

/** What Save and Load need from the worker. */
export type SandboxFileDeps = {
  /** Stop every guest process and seal the running sandbox (it runs
   * nothing more afterwards); undefined when this one cannot be saved. */
  seal: (() => Promise<PageSeal>) | undefined;
  pins: () => Promise<Pins>;
  /** A phone or tablet page. */
  smallDevice: boolean;
  /** Drop the running sandbox and start the shell (and Jupyter) on
   * `image` as a boot would: whether it came up. */
  replace(image: SandboxSealImage): Promise<boolean>;
  /** After a sandbox that did not come up: a fresh one, said so. */
  startFresh(why: string): Promise<void>;
  post(message: SandboxFileMessage): void;
  now?: () => number;
};

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** Save sandbox: seal, hand the file over, restore the same seal in place.
 * A seal that fails has already stopped the shell, so a fresh sandbox
 * follows, said so. */
export async function saveSandbox(deps: SandboxFileDeps): Promise<void> {
  const now = deps.now ?? (() => performance.now());
  const started = now();
  const done = (ok: boolean, changed: boolean, why?: string) =>
    deps.post({
      type: "sandbox-done",
      action: "save",
      ok,
      changed,
      ...(why === undefined ? {} : { why }),
      ms: Math.round(now() - started),
    });
  if (deps.seal === undefined) {
    done(false, false, "this sandbox cannot be saved");
    return;
  }
  let image: PageSeal;
  let blob: Blob;
  try {
    image = await deps.seal();
  } catch (error) {
    const why = `saving failed: ${errorText(error)}`;
    deps.post({ type: "sandbox-replacing", action: "save" });
    await deps.startFresh(why);
    done(false, true, why);
    return;
  }
  try {
    blob = await encodeSandboxSnapshot(
      image,
      savedBuiltFrom(await deps.pins()),
    );
  } catch (error) {
    // Sealed, but no file: the session still comes back on the seal.
    deps.post({ type: "sandbox-replacing", action: "save" });
    await comeBack(deps, image);
    done(false, true, `saving failed: ${errorText(error)}`);
    return;
  }
  deps.post({
    type: "sandbox-saved",
    blob,
    name: savedFileName(new Date()),
    ms: Math.round(now() - started),
  });
  deps.post({ type: "sandbox-replacing", action: "save" });
  const why = await comeBack(deps, image);
  done(why === undefined, true, why);
}

/** Replace the sandbox with `image`; when it does not come up, a fresh
 * sandbox takes its place and the reason is returned. */
async function comeBack(
  deps: SandboxFileDeps,
  image: SandboxSealImage,
): Promise<string | undefined> {
  if (await deps.replace(image)) return undefined;
  const why = "the sealed sandbox did not start again";
  await deps.startFresh(why);
  return why;
}

/** Load sandbox: `file` read and checked whole while the running sandbox
 * is untouched; a refusal changes nothing. Then the sandbox is replaced by
 * it; one that does not come up gives way to a fresh sandbox. */
export async function loadSandbox(
  deps: SandboxFileDeps,
  file: Blob,
): Promise<void> {
  const now = deps.now ?? (() => performance.now());
  const started = now();
  const done = (ok: boolean, changed: boolean, why?: string) =>
    deps.post({
      type: "sandbox-done",
      action: "load",
      ok,
      changed,
      ...(why === undefined ? {} : { why }),
      ms: Math.round(now() - started),
    });
  // The running sandbox is what a loaded one replaces: none, nothing to do.
  if (deps.seal === undefined) {
    done(false, false, "this sandbox cannot load a snapshot");
    return;
  }
  let image: SandboxSealImage;
  try {
    image = await decodeLoadedSnapshot(
      file.stream(),
      snapshotIdentity(await deps.pins()),
      deps.smallDevice,
    );
  } catch (error) {
    done(false, false, errorText(error));
    return;
  }
  deps.post({ type: "sandbox-replacing", action: "load" });
  const why = await comeBack(deps, image);
  done(why === undefined, true, why);
}
