/**
 * Python on the slim image: when the site's pins name a slim image
 * (`browserImage`), the coordinator installs the Python set with the
 * guest's own `pkg` (src/packages.ts) when the image lacks it (no python3,
 * or only the python package; src/coordinator_start.ts), before
 * it starts ipykernel. Which builds is the live signed repository's answer,
 * not the page's: the newest complete set (see {@link PYTHON_SET}).
 */
import {
  type Catalog,
  fetchWithProgress,
  loadCatalog,
  resolveSet,
  SetNotOffered,
} from "./packages.ts";
import type { InstalledRelease } from "./installed_list.ts";
import { parsePins, type Pins } from "./pins.ts";
import { IndexUnreadable, layerKey } from "./python_layer.ts";

export { IndexUnreadable };

/** The progress messages' label: "Python: downloading python 1.2 MiB of
 * 22.6 MiB". */
export const PYTHON_LABEL = "Python";

/**
 * The Python set, in install order. numpy's and pyzmq's C extensions are
 * linked into python's interpreter, so the four are published together and
 * share one `yurt_N` build, the set's marker; the page installs the newest
 * build all four have, and never a set that is only partly published.
 */
export const PYTHON_SET = ["python", "numpy", "pyzmq", "jupyter-kernel"];

/** The set's sealable CPython, for the Suspend/Resume kernel: the same
 * `yurt_N` build as the set it belongs to, never installed in a sandbox;
 * that kernel reads its interpreter out of this archive and its standard
 * library out of `python`'s. */
export const SEAL_PACKAGE = "python-seal";
export const SEAL_WASM_PATH = "/usr/local/lib/yurt/python3-seal.wasm";

/** What the coordinator installs for Python: the set, resolved against the
 * live index at install time. `undefined` when the site boots the full
 * image (which has Python) and so installs nothing. `installed`: the
 * python the slim image ships (its pin's `python`), which pins the set to
 * its build (src/packages.ts `resolveSet`) -- for the snapshot's and the
 * stored layer's keys, read before the sandbox is; the install itself
 * reads the sandbox's own installed list. */
export function pythonInstallRequest(
  pins: Pick<Pins, "browserImage">,
):
  | {
    label: string;
    set: string[];
    image: string;
    installed?: InstalledRelease[];
  }
  | undefined {
  const slim = pins.browserImage;
  return slim === undefined ? undefined : {
    label: PYTHON_LABEL,
    set: [...PYTHON_SET],
    // What a stored install is keyed by (src/python_layer.ts).
    image: slim.sha256,
    ...(slim.python === undefined
      ? {}
      : { installed: [{ name: "python", ...slim.python }] }),
  };
}

/** The Install button's state on an image without python3. */
export function pythonInstallState(
  pins: Pick<Pins, "browserImage"> | undefined,
): { available: boolean; reason: string } {
  return pins !== undefined && pythonInstallRequest(pins) !== undefined
    ? { available: true, reason: "" }
    : {
      available: false,
      reason: "this image's Python is not installable here",
    };
}

/** The site's pins, as a page reads them (`/pins.json`, from any page
 * path); `undefined` when they cannot be read, and the page then asks for
 * no install. */
export async function fetchSitePins(): Promise<Pins | undefined> {
  try {
    const response = await fetch("/pins.json");
    if (!response.ok) return undefined;
    return parsePins(await response.json());
  } catch {
    return undefined;
  }
}

/** What the live index is asked about a site's Python set: its members,
 * the slim image, and what the image already has installed of it. */
type PythonSetQuestion = {
  set: readonly string[];
  image?: string;
  installed?: readonly InstalledRelease[];
};

/** How long the live index may take to answer which set it offers; past
 * it, the answer is "cannot tell" (a stored layer, or a snapshot, is then
 * used as when offline). */
const LIVE_INDEX_TIMEOUT_MS = 20_000;

/** The live repository's catalog, its downloads bounded by `signal`. */
const defaultCatalogLoad = (signal: AbortSignal) =>
  loadCatalog((url, limit, onBytes) =>
    fetchWithProgress(url, limit, onBytes, signal)
  );

/** The set the live index offers for `set` on `image`, as a layer key
 * (src/python_layer.ts); undefined when the index answered but does not
 * offer the set (SetNotOffered). Throws IndexUnreadable when the index
 * cannot be had -- downloaded within `timeoutMs` and parsed; a throw while
 * resolving the set (other than SetNotOffered: a crash) is thrown as it
 * is, never taken for an answer. */
export async function liveLayerKey(
  image: string,
  set: readonly string[],
  timeoutMs = LIVE_INDEX_TIMEOUT_MS,
  /** The index read; the live repository's, bounded by `signal`. */
  load: (signal: AbortSignal) => Promise<Catalog> = defaultCatalogLoad,
  /** What pins the set to a build: the python the image ships. */
  installed?: readonly InstalledRelease[],
): Promise<string | undefined> {
  const giveUp = new AbortController();
  const timer = setTimeout(() => giveUp.abort(), timeoutMs);
  let catalog: Catalog;
  try {
    catalog = await load(giveUp.signal);
  } catch (error) {
    // Any failure to have the index -- a download that failed or ran past
    // the bound, an index or package file that does not parse -- is no
    // answer: as offline (a stored layer, or a snapshot, is used). pkg
    // would read the same index, and fail the same way. (The page does
    // not check the index's signature; the guest's pkg does.)
    throw new IndexUnreadable(
      error instanceof Error ? error.message : String(error),
      { cause: error },
    );
  } finally {
    clearTimeout(timer);
  }
  let releases: ReturnType<typeof resolveSet>;
  try {
    releases = resolveSet(catalog, set, installed);
  } catch (error) {
    // The repository answered: a set it does not offer (yanked, removed,
    // incomplete) is no layer's either.
    if (error instanceof SetNotOffered) return undefined;
    throw error;
  }
  return layerKey(image, releases);
}

/** A snapshot's `pythonSet` as the live index would make it now -- the one
 * mapping the page (`?snapshot=1`) and scripts/release-snapshot.ts share:
 * null when the site installs no Python; NO_COMPLETE_SET when the index
 * answered without the set (no snapshot matches that); undefined when the
 * index cannot be had, downloaded in time and parsed (the snapshot is then
 * used, as a stored layer is offline). A crash while resolving the set is
 * thrown, never taken for one of these. */
export async function livePythonSet(
  request: PythonSetQuestion | undefined,
  timeoutMs = LIVE_INDEX_TIMEOUT_MS,
  load?: (signal: AbortSignal) => Promise<Catalog>,
): Promise<string | null | undefined> {
  if (request?.image === undefined) return null;
  try {
    return await liveLayerKey(
      request.image,
      request.set,
      timeoutMs,
      load,
      request.installed,
    ) ?? NO_COMPLETE_SET;
  } catch (error) {
    if (error instanceof IndexUnreadable) {
      console.info("the live package index could not be had:", error);
      return undefined;
    }
    throw error;
  }
}

/** One boot's two questions to the live index about `request`'s Python
 * set -- a snapshot's (`pythonSet`), then the install's stored layer
 * (`layerKey`) -- answered from one read of it, kept for that boot, a
 * failed read included (no second 20 s wait). The install's answer, or
 * `finish` when the boot is over (a restore, a capture, a tablet: no
 * install's question), ends the boot's read: a later question (a retry on
 * the same sandbox) reads again. Made anew for each boot. The two questions come one after the
 * other: the first one's time bound bounds the shared read. */
export function liveAnswers(
  request: PythonSetQuestion | undefined,
  load: (signal: AbortSignal) => Promise<Catalog> = defaultCatalogLoad,
): {
  pythonSet: () => Promise<string | null | undefined>;
  layerKey: () => Promise<string | undefined>;
  /** The boot is over: drop its read; a later question reads again. */
  finish: () => void;
} {
  let read: Promise<Catalog> | undefined;
  let finished = false;
  const once = (signal: AbortSignal) =>
    finished ? load(signal) : read ??= load(signal);
  const finish = () => {
    finished = true;
    read = undefined;
  };
  return {
    pythonSet: () => livePythonSet(request, undefined, once),
    layerKey: async () => {
      if (request?.image === undefined) return undefined;
      try {
        return await liveLayerKey(
          request.image,
          request.set,
          undefined,
          once,
          request.installed,
        );
      } finally {
        finish();
      }
    },
    finish,
  };
}

/** What {@link livePythonSet} says for an index without a complete set. */
export const NO_COMPLETE_SET = "(no complete set)";
