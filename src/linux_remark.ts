/**
 * One line that tells a person what is in this Linux, made from pkg's
 * installed list: the page shows it above the terminal, the shell prints
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

/** E.g. "BusyBox shell, git 2.55.0, Python 3.14.7; no Jupyter". The shell
 * is BusyBox in every playground image, so it is always named; pkg does
 * not list it. */
export function linuxRemark(releases: readonly InstalledRelease[]): string {
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
  const missing = !byName.has("python")
    ? "no Python, no Jupyter"
    : !byName.has("jupyter-kernel")
    ? "no Jupyter"
    : undefined;
  return missing === undefined
    ? parts.join(", ")
    : `${parts.join(", ")}; ${missing}`;
}
