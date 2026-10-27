/**
 * Python on the slim image: when the site's pins name a slim image
 * (`browserImage`), the coordinator installs the Python set with the
 * guest's own `pkg` (src/packages.ts) when the image has no python3, before
 * it starts ipykernel. Which builds is the live signed repository's answer,
 * not the page's: the newest complete set (see {@link PYTHON_SET}).
 */
import { parsePins, type Pins } from "./pins.ts";

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
): { label: string; set: string[] } | undefined {
  return pins.browserImage === undefined
    ? undefined
    : { label: PYTHON_LABEL, set: [...PYTHON_SET] };
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
