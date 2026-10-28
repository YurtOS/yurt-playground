/**
 * Python on the slim image: when the site's pins name a slim image
 * (`browserImage`), the coordinator installs the Python set with the
 * guest's own `pkg` (src/packages.ts) when the image has no python3, before
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
 * image (which has Python) and so installs nothing. */
export function pythonInstallRequest(
  pins: Pick<Pins, "browserImage">,
): { label: string; set: string[]; image: string } | undefined {
  return pins.browserImage === undefined ? undefined : {
    label: PYTHON_LABEL,
    set: [...PYTHON_SET],
    // What a stored install is keyed by (src/python_layer.ts).
    image: pins.browserImage.sha256,
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

/** How long the live index may take to answer which set it offers; past
 * it, the answer is "cannot tell" (a stored layer, or a snapshot, is then
 * used as when offline). */
export const LIVE_INDEX_TIMEOUT_MS = 20_000;

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
    releases = resolveSet(catalog, set);
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
  request: { set: readonly string[]; image?: string } | undefined,
  timeoutMs = LIVE_INDEX_TIMEOUT_MS,
  load?: (signal: AbortSignal) => Promise<Catalog>,
): Promise<string | null | undefined> {
  if (request?.image === undefined) return null;
  try {
    return await liveLayerKey(request.image, request.set, timeoutMs, load) ??
      NO_COMPLETE_SET;
  } catch (error) {
    if (error instanceof IndexUnreadable) {
      console.info("the live package index could not be had:", error);
      return undefined;
    }
    throw error;
  }
}

/** A loader for {@link liveLayerKey} and {@link livePythonSet} that reads
 * the live index once and shares it (its failure included) between them:
 * one boot asks the same question once. */
export function catalogOnce(
  load: (signal: AbortSignal) => Promise<Catalog> = defaultCatalogLoad,
): (signal: AbortSignal) => Promise<Catalog> {
  let loaded: Promise<Catalog> | undefined;
  return (signal) => loaded ??= load(signal);
}

/** What {@link livePythonSet} says for an index without a complete set. */
export const NO_COMPLETE_SET = "(no complete set)";
