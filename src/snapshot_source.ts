/**
 * Uploaded sandbox snapshots: `?snapshot=<id>` restores a snapshot that
 * scripts/snapshot-local.ts captured and uploaded, with no pin and no site
 * deploy. `?snapshot=1` (the pinned one, src/sandbox_snapshot.ts) is
 * unchanged.
 *
 * Where they live: each snapshot is one commit, with no parent, in
 * YurtOS/yurt-playground, under `refs/snapshots/<name>` -- not a branch, so
 * a clone does not fetch its 130 MB. `<id>` is that commit's sha. The page
 * reads it from raw.githubusercontent.com, which answers any origin
 * (`Access-Control-Allow-Origin: *`, `Cross-Origin-Resource-Policy:
 * cross-origin`, so a cross-origin isolated page may read it); a GitHub
 * release download sends no CORS header, which is why the pinned snapshot
 * is copied into the site instead. A commit sha names fixed content.
 *
 * The commit holds:
 * - `manifest.json`: the pin's shape (src/pins.ts `SnapshotPin`: format,
 *   the whole file's sha256 and size, each part's sha256, builtFrom), plus
 *   what the script adds for people (`packages`, `name`);
 * - `sandbox.seal.gz.parts.json` and the parts, as the site publishes the
 *   pinned one (src/image_parts.ts).
 *
 * Who may publish one: raw.githubusercontent.com serves, under this
 * repository's path, any commit of its fork network -- a fork's, a pull
 * request's. So before anything of a snapshot is read, the page asks the
 * GitHub API ({@link SNAPSHOT_REFS_API}, CORS-enabled) for the repository's
 * `refs/snapshots/*` and requires one of them to point at `<id>`: only the
 * repository's writers can push those refs. An answer that cannot be had
 * (60 unauthenticated requests an hour per address) refuses the snapshot.
 *
 * Only those two fixed paths are ever read, and only for an id of 40 hex
 * digits: the query string never names a URL. The manifest goes through
 * every check a pin does (format, build, Python set), and each part is
 * checked against it as it arrives; any failure boots the image as without
 * the flag (src/boot.ts `snapshotOrBoot`).
 */
import {
  acceptedSnapshot,
  SnapshotMismatch,
  type SnapshotPin,
} from "./sandbox_snapshot.ts";
import type { Pins } from "./pins.ts";
import { isPackageName } from "./packages.ts";

/** The repository that holds uploaded snapshots. */
export const SNAPSHOT_REPO = "YurtOS/yurt-playground";
/** The one path the page reads them from: also its CSP entry
 * (src/csp.ts). */
export const SNAPSHOT_SOURCE =
  `https://raw.githubusercontent.com/${SNAPSHOT_REPO}/`;
/** The ref namespace a snapshot's commit is pushed under. */
export const SNAPSHOT_REF_PREFIX = "refs/snapshots/";
/** Where the page learns which commits those refs point at: also a CSP
 * entry (src/csp.ts). */
export const SNAPSHOT_REFS_API =
  `https://api.github.com/repos/${SNAPSHOT_REPO}/git/matching-refs/snapshots/`;
/** The commit's files. */
export const SNAPSHOT_MANIFEST = "manifest.json";
export const SNAPSHOT_FILE = "sandbox.seal.gz";

/** A commit sha, the only form `?snapshot=<id>` takes. */
const ID = /^[0-9a-f]{40}$/;

/** Whether `value` (a `?snapshot=` value) names an uploaded snapshot. */
export function isUploadedSnapshotId(value: string | null | undefined) {
  return typeof value === "string" && ID.test(value);
}

/** The directory an uploaded snapshot's files are read from. */
export function uploadedSnapshotBase(id: string): string {
  if (!isUploadedSnapshotId(id)) {
    throw new Error(`not an uploaded snapshot id: ${JSON.stringify(id)}`);
  }
  return `${SNAPSHOT_SOURCE}${id}/`;
}

/** The snapshot file's path, for src/sandbox_snapshot.ts
 * `fetchVerifiedSnapshot` (which reads `<path>.parts.json`). */
export function uploadedSnapshotPath(id: string): string {
  return `${uploadedSnapshotBase(id)}${SNAPSHOT_FILE}`;
}

/** A `fetch` that refuses every URL outside `base`: the parts list is
 * read from the snapshot's own commit, and a name in it must not lead
 * anywhere else (`../`, another host). */
export function confinedFetch(
  base: string,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): typeof globalThis.fetch {
  return (input, init) => {
    const href = input instanceof Request ? input.url : String(input);
    const url = new URL(href);
    if (!url.href.startsWith(base) || url.search !== "" || url.hash !== "") {
      return Promise.reject(
        new Error(`refusing ${url.href}: not under ${base}`),
      );
    }
    // A redirect would leave the checked URL.
    return fetchImpl(url, { ...init, redirect: "error" });
  };
}

/** The `refs/snapshots/*` ref of {@link SNAPSHOT_REPO} that points at
 * commit `id`. A commit no such ref names -- one that came from a fork or
 * a pull request -- is refused ({@link SnapshotMismatch}); an answer that
 * cannot be had throws too. */
export async function snapshotRef(
  id: string,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<string> {
  uploadedSnapshotBase(id);
  const response = await fetchImpl(SNAPSHOT_REFS_API, {
    headers: { accept: "application/vnd.github+json" },
    redirect: "error",
    // The list is served with `max-age=60`: a snapshot uploaded within
    // the minute after this browser last asked would not be in its copy.
    // Revalidated (ETag) instead.
    cache: "no-cache",
  });
  if (!response.ok) {
    throw new Error(
      `uploaded snapshot ${id}: cannot list ${SNAPSHOT_REPO}'s snapshot refs: ${response.status}`,
    );
  }
  const refs = await response.json() as unknown;
  const match = Array.isArray(refs)
    ? refs.find((entry) =>
      typeof entry?.ref === "string" &&
      entry.ref.startsWith(SNAPSHOT_REF_PREFIX) &&
      entry.object?.type === "commit" && entry.object?.sha === id
    )
    : undefined;
  if (match === undefined) {
    throw new SnapshotMismatch(
      `uploaded snapshot ${id} is not a ${SNAPSHOT_REF_PREFIX}* commit of ${SNAPSHOT_REPO}`,
    );
  }
  return match.ref;
}

/** An uploaded snapshot, as `?snapshot=1`'s pin is used: its manifest,
 * accepted by every rule a pin is (src/sandbox_snapshot.ts
 * `acceptedSnapshot`), where its file is, and the fetch that may read it.
 * A manifest that cannot be had, or is not this site's, throws. */
export async function uploadedSnapshot(
  id: string,
  pins: Pins,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<{ pin: SnapshotPin; path: string; fetch: typeof fetch }> {
  const base = uploadedSnapshotBase(id);
  // Published by the repository's writers, before any byte of it is read.
  await snapshotRef(id, fetchImpl);
  const fetch = confinedFetch(base, fetchImpl);
  const response = await fetch(`${base}${SNAPSHOT_MANIFEST}`);
  if (!response.ok) {
    throw new Error(
      `uploaded snapshot ${id}: fetch ${SNAPSHOT_MANIFEST} failed: ${response.status}`,
    );
  }
  let manifest: unknown;
  try {
    manifest = await response.json();
  } catch (error) {
    throw new Error(
      `uploaded snapshot ${id}: ${SNAPSHOT_MANIFEST} is not JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return {
    pin: acceptedSnapshot(manifest, pins, `uploaded snapshot ${id}`),
    path: `${base}${SNAPSHOT_FILE}`,
    fetch,
  };
}

/** `?snapshot=capture&packages=a,b`'s packages, installed after the
 * Python set before the seal; each must be a package name (`pkg`'s rule),
 * or the capture fails before it starts. */
export function capturePackages(value: string | null): string[] {
  if (value === null || value === "") return [];
  const names = value.split(",");
  const bad = names.filter((name) => !isPackageName(name));
  if (bad.length > 0) {
    throw new Error(
      `?packages= names no package: ${
        bad.map((n) => JSON.stringify(n))
          .join(", ")
      }`,
    );
  }
  return [...new Set(names)];
}
