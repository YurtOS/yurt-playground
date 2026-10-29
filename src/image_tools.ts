/**
 * The command line tools an image has outside pkg. The slim image
 * (yurt-ports playground-image) bakes BusyBox, zsh, make, curl, jq,
 * sqlite3, zstd, xz, pkg and sudo into its base without pkg, so pkg's
 * installed list does not name them, and pkg refuses to install a package
 * over them ("would overwrite unmanaged path bin/zsh"). The image keeps no
 * list of them, so the sandbox is asked whether the command is there: a
 * regular file of that name in a command directory. Not a symlink:
 * BusyBox's applets are symlinks (/bin/wget), which a package of that name
 * installed elsewhere would not collide with, while every tool the image
 * bakes in is a file.
 */

/** Where a command lands, in the image and in the archives pkg installs:
 * the image's tools are the same ports' stages, at the same paths. */
export const COMMAND_DIRS = [
  "/bin",
  "/sbin",
  "/usr/bin",
  "/usr/sbin",
  "/usr/local/bin",
];

/** The tools the remark (src/linux_remark.ts) names when the sandbox has
 * them outside pkg, in this order: the base's own command line tools
 * (BusyBox is named anyway, and pkg and sudo are how one installs). */
export const BASE_TOOLS = [
  "zsh",
  "make",
  "curl",
  "jq",
  "sqlite3",
  "zstd",
  "xz",
];

/** Each path at which `command` would be found. */
export function commandPaths(command: string): string[] {
  return COMMAND_DIRS.map((dir) => `${dir}/${command}`);
}

/** The {@link BASE_TOOLS} whose command `isFile` finds, in their order. */
export function baseToolsHeld(isFile: (path: string) => boolean): string[] {
  return BASE_TOOLS.filter((tool) => commandPaths(tool).some(isFile));
}

/** {@link baseToolsHeld} over a sandbox's files; none when the page has no
 * files of its own (the desktop app's session). A path whose check fails
 * counts as not there: the remark is a courtesy, never worth a failed
 * capture. */
export async function baseToolsIn(
  files: { isFile(path: string): Promise<boolean> } | undefined,
): Promise<string[]> {
  if (files === undefined) return [];
  const paths = BASE_TOOLS.flatMap(commandPaths);
  const found = await Promise.all(
    paths.map((path) => files.isFile(path).catch(() => false)),
  );
  const there = new Set(paths.filter((_, i) => found[i]));
  return baseToolsHeld((path) => there.has(path));
}
