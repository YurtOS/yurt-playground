/**
 * Which sandbox snapshots the site pins and when one may be restored: the
 * kinds, their pins, and the identity a snapshot must have been built
 * from. No kernel import here: the local server and the desktop app
 * (scripts/desktop.ts, compiled without the kernel checkout) import this
 * module, while the file codec that needs the kernel host's seal image
 * stays in src/sandbox_snapshot.ts, which re-exports all of it.
 */
import {
  type BuiltFrom,
  parseSnapshotPin,
  type Pins,
  type SnapshotIdentity,
  type SnapshotPin,
} from "./pins.ts";

export type { BuiltFrom, SnapshotIdentity, SnapshotPin };

/** Where the page fetches the snapshot (in parts, src/image_parts.ts). */
export const SANDBOX_SNAPSHOT_NAME = "snapshot/sandbox.seal.zip";
export const SANDBOX_SNAPSHOT_PATH = `./${SANDBOX_SNAPSHOT_NAME}`;

/**
 * Which snapshot a device restores by default (until a boot of the slim
 * image fits a phone again), each made from the slim image: a desktop the
 * one with the Python set and Jupyter installed; a tablet the one with
 * python alone installed; a phone the image as it boots, without Python.
 * A desktop that asks for Go (`?env=go`, or Go on the start screen:
 * src/device.ts chooseEnv) restores the Go one instead: the go package and
 * a build cache that already holds the standard library it compiled, no
 * Python. Each has its own
 * pins.json entry, file, capture mode and release tag; the checks are the
 * same. A phone's or tablet's page asks for no Python set, so it restores
 * only a snapshot without one (checkPythonSet); a Go page asks about the
 * go package (`builtFrom.pythonSet` then holds that package's layer key).
 */
export type SnapshotKind = "desktop" | "tablet" | "phone" | "go" | "playwright";

export const SNAPSHOT_KINDS: Record<SnapshotKind, {
  /** Its artifacts/pins.json entry. */
  pinKey:
    | "snapshot"
    | "tabletSnapshot"
    | "phoneSnapshot"
    | "goSnapshot"
    | "playwrightSnapshot";
  /** Its file in the site, published in parts. */
  name: string;
  /** The release asset (the name's last part). */
  asset: string;
  /** `?snapshot=<capture>` makes it. */
  capture:
    | "capture"
    | "capture-tablet"
    | "capture-phone"
    | "capture-go"
    | "capture-playwright";
  /** Its release tag, before the train. */
  tagPrefix: string;
}> = {
  desktop: {
    pinKey: "snapshot",
    name: SANDBOX_SNAPSHOT_NAME,
    asset: "sandbox.seal.zip",
    capture: "capture",
    tagPrefix: "snapshot-",
  },
  tablet: {
    pinKey: "tabletSnapshot",
    name: "snapshot/tablet.seal.zip",
    asset: "tablet.seal.zip",
    capture: "capture-tablet",
    tagPrefix: "snapshot-tablet-",
  },
  phone: {
    pinKey: "phoneSnapshot",
    name: "snapshot/phone.seal.zip",
    asset: "phone.seal.zip",
    capture: "capture-phone",
    tagPrefix: "snapshot-phone-",
  },
  go: {
    pinKey: "goSnapshot",
    name: "snapshot/go.seal.zip",
    asset: "go.seal.zip",
    capture: "capture-go",
    tagPrefix: "snapshot-go-",
  },
  // The Playwright demo's (src/playwright_demo.ts): node, playwright-core
  // and the yurt-chrome module already in the login home, no Python.
  playwright: {
    pinKey: "playwrightSnapshot",
    name: "snapshot/playwright.seal.zip",
    asset: "playwright.seal.zip",
    capture: "capture-playwright",
    tagPrefix: "snapshot-playwright-",
  },
};

/** The page query that restores `kind` (the platform it is made for, and
 * Go's `env`): what a printed restore URL and a live check open. */
export function kindQuery(kind: SnapshotKind): string {
  return kind === "go" || kind === "playwright"
    ? `platform=desktop&env=${kind}`
    : `platform=${kind}`;
}

export const SNAPSHOT_KIND_NAMES = Object.keys(
  SNAPSHOT_KINDS,
) as SnapshotKind[];

/** The kind `?snapshot=<value>` captures, or undefined. */
export function captureKindOf(
  value: string | null,
): SnapshotKind | undefined {
  return SNAPSHOT_KIND_NAMES.find((kind) =>
    SNAPSHOT_KINDS[kind].capture === value
  );
}

/** The tablet snapshot's Python: the interpreter alone, installed with
 * pkg on the slim image (no numpy, pyzmq or Jupyter kernel: a tablet runs
 * no Jupyter). Its capture installs it, and its restore asks the live
 * index about it, keyed like the full set (a layer key). */
export const TABLET_PYTHON_SET: readonly string[] = ["python"];

export function tabletPythonRequest(
  pins: Pick<Pins, "browserImage">,
): { label: string; set: string[]; image: string } | undefined {
  return pins.browserImage === undefined ? undefined : {
    label: "Python",
    set: [...TABLET_PYTHON_SET],
    image: pins.browserImage.sha256,
  };
}

/** The Go snapshot's set: the go package alone, installed with pkg on the
 * slim image. Its capture installs it and warms its build cache
 * (src/capture_outcome.ts goWarmupScript), and its restore asks the
 * live index about it, keyed like a Python set (a layer key). */
export const GO_SET: readonly string[] = ["go"];

export function goSetRequest(
  pins: Pick<Pins, "browserImage">,
): { label: string; set: string[]; image: string } | undefined {
  return pins.browserImage === undefined ? undefined : {
    label: "Go",
    set: [...GO_SET],
    image: pins.browserImage.sha256,
  };
}

/** The Playwright snapshot's set: node alone, installed with pkg on the
 * slim image; its capture then stages playwright-core and the yurt-chrome
 * module (src/playwright_setup.ts), and its restore asks the live index
 * about node, keyed like a Python set (a layer key). */
export const PLAYWRIGHT_SET: readonly string[] = ["node"];

export function playwrightSetRequest(
  pins: Pick<Pins, "browserImage">,
): { label: string; set: string[]; image: string } | undefined {
  return pins.browserImage === undefined ? undefined : {
    label: "node",
    set: [...PLAYWRIGHT_SET],
    image: pins.browserImage.sha256,
  };
}

/** What a snapshot holds, recorded at capture: pkg's installed list and
 * one line for people (src/linux_remark.ts). */
export type SnapshotContents = {
  packages: { name: string; version: string; build: string }[];
  remark: string;
};
/** The seal image version this page's host writes and restores
 * (src/sandbox_snapshot.ts checks it against the host's own type). */
export const SEAL_VERSION = 1;

/** The page's boot setup, as a snapshot records it: bump it when
 * src/boot.ts changes what a boot stages beside the image or how it sets
 * up the login user, so a snapshot made the old way is not restored.
 * 2: /etc/motd holds this Linux's remark (src/linux_remark.ts). */
export const BOOT_SETUP = 2;

/** The identity a snapshot made under `pins` records, and a restore under
 * them requires. */
export function snapshotIdentity(
  pins: Pick<Pins, "kernelWasm" | "image" | "browserImage" | "pythonSeal">,
): SnapshotIdentity {
  return {
    kernelSha256: pins.kernelWasm.sha256,
    kernelRev: pins.kernelWasm.rev,
    sealVersion: SEAL_VERSION,
    bootSetup: BOOT_SETUP,
    imageSha256: (pins.browserImage ?? pins.image).sha256,
    pythonSealSha256: pins.pythonSeal?.sha256 ?? null,
  };
}

/** A snapshot built from something else than this site's pins (or one in
 * an older format that does not say, or none pinned at all). Nothing of
 * its memory was read. */
export class SnapshotMismatch extends Error {}

/** The site's pinned snapshot of `kind`, when the entry is well formed
 * and was built from the site's own pins: what a restore may download. */
export function pinnedSnapshot(
  pins: Pins,
  kind: SnapshotKind = "desktop",
  /** Whether the kernel's root is a YurtFS store ({@link storeRefusal}). */
  rootStore?: boolean,
): SnapshotPin {
  const entry = pins[SNAPSHOT_KINDS[kind].pinKey];
  if (entry === undefined) {
    throw new SnapshotMismatch(
      kind === "desktop"
        ? "the site pins no sandbox snapshot"
        : `the site pins no ${kind} snapshot (${SNAPSHOT_KINDS[kind].pinKey})`,
    );
  }
  return acceptedSnapshot(entry, pins, undefined, rootStore);
}

/** A snapshot entry (the pin's shape: `?snapshot=1`'s pin, or an uploaded
 * snapshot's manifest, src/snapshot_source.ts) when it is well formed, of
 * this page's format and built from `pins`; else {@link SnapshotMismatch},
 * its message starting with `what`. */
export function acceptedSnapshot(
  entry: unknown,
  pins: Pins,
  what = "pinned snapshot",
  /** Whether the kernel's root is a YurtFS store: the page knows, and
   * takes only a snapshot with ({@link storeRefusal}) or without one;
   * undefined (the release tools, which check a file against the pins and
   * mount nothing) takes either. */
  rootStore?: boolean,
): SnapshotPin {
  let pin: SnapshotPin;
  try {
    pin = parseSnapshotPin(entry);
  } catch (error) {
    throw new SnapshotMismatch(
      `the ${what} entry is malformed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const refused = formatRefusal(pin.format) ??
    storeRefusal(pin.store !== undefined, rootStore);
  if (refused !== undefined) {
    throw new SnapshotMismatch(`the ${what} ${refused}`);
  }
  const why = buildMismatch(pin.builtFrom, snapshotIdentity(pins));
  if (why !== undefined) {
    throw new SnapshotMismatch(
      `${what} ${why.replace(/^sandbox snapshot /, "")}`,
    );
  }
  return pin;
}

/** Refuses a snapshot whose Python set is not the one the live index
 * offers now (`live`, a layer key as liveLayerKey makes it): installing
 * would give another set, so restoring this one would not be the same.
 * `live` undefined -- the index could not be asked -- takes the snapshot,
 * as a stored layer is used offline. */
export function checkPythonSet(
  builtFrom: BuiltFrom,
  live: string | null | undefined,
): void {
  if (live === undefined || live === builtFrom.pythonSet) return;
  throw new SnapshotMismatch(
    live === null
      // No request at all, the index not asked: a phone, a shell-only
      // session, or a page without its pins.
      ? `this page installs no Python (a phone, a shell-only session, or no pins), and the snapshot holds ${builtFrom.pythonSet}`
      : builtFrom.pythonSet === null
      ? `the snapshot holds no Python set, the live index offers ${live}`
      : `the snapshot's Python set is ${builtFrom.pythonSet}, the live index offers ${live}`,
  );
}

/** The snapshot's format: 2 added `builtFrom`, 3 its `pythonSet` (each
 * a gzip of header and memory); 4 is a zip, which also carries the
 * YurtFS root store once the kernel has one. */
export const FORMAT = 4;

/** Why a snapshot of `format` is not one this page reads -- "is format
 * N, not 4..." -- or undefined. */
export function formatRefusal(format: unknown): string | undefined {
  if (format === FORMAT) return undefined;
  return `is format ${format}, not ${FORMAT}${
    format === 3
      ? ": a gzip of the kernel memory, from before the zip; capture it again"
      : ""
  }`;
}

/** Why a snapshot with (`hasStore`) or without a YurtFS root store is not
 * restored on a kernel whose root is (`rootStore`) or is not a store, or
 * undefined. `rootStore` undefined takes either. */
export function storeRefusal(
  hasStore: boolean,
  rootStore: boolean | undefined,
): string | undefined {
  if (rootStore === undefined || hasStore === rootStore) return undefined;
  return hasStore
    ? "carries a YurtFS root store, and this kernel keeps its root filesystem in its memory"
    : "holds the kernel memory alone, and this kernel's root filesystem is a YurtFS store that it does not hold; capture it again";
}

/** Why a snapshot's `builtFrom` is not `expected` (every field `expected`
 * has), or undefined when it is the same build. */
export function buildMismatch(
  builtFrom: Partial<BuiltFrom> | undefined,
  expected: SnapshotIdentity | BuiltFrom,
): string | undefined {
  if (builtFrom === undefined) {
    return "sandbox snapshot does not say what it was built from (an older format)";
  }
  const want = expected as Partial<BuiltFrom>;
  const differs = (Object.keys(want) as (keyof BuiltFrom)[])
    .filter((key) => builtFrom[key] !== want[key])
    .map((key) => `${key} ${builtFrom[key]}, not ${want[key]}`);
  return differs.length === 0
    ? undefined
    : `sandbox snapshot was built from ${differs.join("; ")}`;
}
