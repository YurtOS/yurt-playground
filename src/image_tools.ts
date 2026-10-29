/**
 * The command line tools an image has outside pkg. The slim image
 * (yurt-ports playground-image) bakes BusyBox, zsh, make, curl, jq,
 * sqlite3, zstd, xz, pkg and sudo into its base without pkg, so pkg's
 * installed list does not name them, and pkg refuses to install a package
 * over them ("would overwrite unmanaged path bin/zsh"). The image keeps no
 * list of them, so the sandbox is asked whether the command is there: a
 * file or symlink of that name in a command directory.
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

/** The {@link BASE_TOOLS} a sandbox's files hold; none when the page has
 * no files of its own (the desktop app's session). */
export async function baseToolsIn(
  files: { exists(path: string): Promise<boolean> } | undefined,
): Promise<string[]> {
  if (files === undefined) return [];
  const held: string[] = [];
  for (const tool of BASE_TOOLS) {
    for (const path of commandPaths(tool)) {
      if (await files.exists(path)) {
        held.push(tool);
        break;
      }
    }
  }
  return held;
}
