/**
 * Python on the slim image: the release train pins the packages a page
 * needs for Python and the Jupyter kernel (artifacts/pins.json `packages`
 * and `pythonPackages`), and the coordinator installs exactly those builds
 * with the guest's own `pkg` (src/packages.ts) when the image has no
 * python3, before it starts ipykernel.
 */
import { parsePins, type Pins } from "./pins.ts";
import type { PinnedRelease } from "./packages.ts";

/** The progress messages' label: "Python: downloading python 1.2 MiB of
 * 22.6 MiB". */
export const PYTHON_LABEL = "Python";

/** What the coordinator installs for Python, in one `pkg install`: the
 * pinned builds, in the pins' order (Python first, then the kernel's
 * packages). `undefined` when the train pins no Python packages: the page
 * then has nothing it may install. */
export function pythonInstallRequest(
  pins: Pick<Pins, "packages" | "pythonPackages">,
): { label: string; releases: PinnedRelease[] } | undefined {
  const names = pins.pythonPackages;
  if (names === undefined || names.length === 0) return undefined;
  const releases: PinnedRelease[] = [];
  for (const name of names) {
    const pin = pins.packages?.[name];
    if (pin === undefined) return undefined;
    releases.push({ name, ...pin });
  }
  return { label: PYTHON_LABEL, releases };
}

/** The Install button's state on an image without python3. */
export function pythonInstallState(
  pins: Pick<Pins, "packages" | "pythonPackages"> | undefined,
): { available: boolean; reason: string } {
  return pins !== undefined && pythonInstallRequest(pins) !== undefined
    ? { available: true, reason: "" }
    : {
      available: false,
      reason: "this release of the page pins no Python packages",
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
