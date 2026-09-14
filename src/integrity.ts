/**
 * What the browser downloaded, by hash.
 *
 * The site cannot prove to a visitor that the sandbox runs in their tab, but
 * it can make the claim checkable: `integrity.json` lists the SHA-256 of the
 * files the page runs on and the commit it was built from, the home page
 * re-hashes what it actually fetched, and the public repository lets anyone
 * compare either against a build of their own.
 */

/** The guest filesystem image: BusyBox, Python, everything the guest runs. */
export const IMAGE_NAME = "playground.yurtimg";

/**
 * The files the sandbox runs on, in the order the home page lists them. The
 * image's hash is of the whole file; the static site serves it in parts
 * (image_parts.ts), and the page hashes them reassembled.
 */
export const INTEGRITY_FILES = [
  "boot.bundle.js",
  "coordinator.bundle.js",
  "worker_bootstrap.js",
  "playground-bridge.js",
  "yurt_kernel.wasm",
  IMAGE_NAME,
] as const;

export type IntegrityManifest = {
  /** The commit the site was built from, when the build knew it. */
  commit: string | null;
  /** File name (as served from the site root) to lowercase hex SHA-256. */
  files: Record<string, string>;
};

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    bytes as BufferSource,
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function integrityManifest(
  read: (name: string) => Promise<Uint8Array>,
  commit: string | null,
): Promise<IntegrityManifest> {
  const files: Record<string, string> = {};
  for (const name of INTEGRITY_FILES) {
    files[name] = await sha256Hex(await read(name));
  }
  return { commit, files };
}
