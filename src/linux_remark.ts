/**
 * One line that tells a person what is in this Linux, made from pkg's
 * installed list and the tools the image has outside pkg
 * (src/image_tools.ts): the page shows it above the terminal, the shell prints
 * it when it starts, and /etc/motd holds it. A snapshot records it too
 * (src/sandbox_snapshot.ts `contents`).
 */
import type { InstalledRelease } from "./installed_list.ts";

/** The packages the remark names by name, in this order; the rest are
 * counted. */
const NAMED: [string, string][] = [
  ["git", "git"],
  ["python", "Python"],
  ["numpy", "numpy"],
  ["pyzmq", "pyzmq"],
  ["jupyter-kernel", "Jupyter kernel"],
];

/** E.g. "BusyBox shell, git 2.55.0, Python 3.14.7; also zsh, make; no
 * Jupyter". The shell is BusyBox in every playground image, so it is
 * always named; pkg does not list it. `tools`: those of
 * src/image_tools.ts `BASE_TOOLS` the sandbox has, named after "also" in
 * the order given, unless pkg lists one by that name. */
export function linuxRemark(
  releases: readonly InstalledRelease[],
  tools: readonly string[] = [],
): string {
  const byName = new Map(releases.map((release) => [release.name, release]));
  const parts = ["BusyBox shell"];
  for (const [name, label] of NAMED) {
    const release = byName.get(name);
    if (release !== undefined) parts.push(`${label} ${release.version}`);
  }
  const named = new Set(NAMED.map(([name]) => name));
  const others = releases.filter((release) => !named.has(release.name));
  if (others.length > 0) {
    parts.push(
      others.length === 1
        ? others[0].name
        : `${others.length} more packages (pkg list)`,
    );
  }
  const also = tools.filter((tool) => !byName.has(tool));
  const held = also.length === 0
    ? parts.join(", ")
    : `${parts.join(", ")}; also ${also.join(", ")}`;
  const missing = !byName.has("python")
    ? "no Python, no Jupyter"
    : !byName.has("jupyter-kernel")
    ? "no Jupyter"
    : undefined;
  return missing === undefined ? held : `${held}; ${missing}`;
}
