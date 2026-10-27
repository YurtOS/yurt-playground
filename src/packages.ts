/**
 * Packages in the browser: install a package from YurtOS/yurt-packages into
 * the in-tab sandbox, which has no network of its own.
 *
 * The page fetches what `pkg` would fetch -- the signed `index.json`, the
 * package metadata, and the archives with their Sigstore bundles -- and lays
 * them out in the guest as a file-backed copy of the repository. The guest's
 * own `pkg` then runs `update` and `install` against that copy, trusting the
 * same signing identity and Sigstore trust root the image configures for
 * the real repository. Every check desktop `pkg` makes (the index and
 * archive signatures, the sha256 and size of every file the index names, the
 * archive's own metadata) runs in the guest, unchanged; the page only moves
 * bytes. It also checks each archive's sha256 against the metadata before
 * handing it over, which fails a corrupt download early but proves nothing
 * the guest does not check again.
 *
 * Installed files live in the tab's memory, like every other file in the
 * sandbox, and are gone after a reload (#81).
 */

/** Where the page fetches the repository from: GitHub's raw file host,
 * which answers with `Access-Control-Allow-Origin: *`. */
export const PACKAGE_REPO_URL =
  "https://raw.githubusercontent.com/YurtOS/yurt-packages/main/";

/** What `connect-src` must allow for {@link PACKAGE_REPO_URL}: that
 * repository's files, not every file the host serves. */
export const PACKAGE_SOURCES = [
  "https://raw.githubusercontent.com/YurtOS/yurt-packages/",
];

/** The repository the image's trust configuration must name: the one entry
 * of `trusted-repos.toml` whose signing identity the browser copy reuses,
 * found by these two consecutive path segments of its URL. */
const TRUSTED_REPO = ["YurtOS", "yurt-packages"];

/** The image's `pkg` configuration (yurt-pkg docs/pkg.md, "Trust Inputs"). */
export const TRUSTED_REPOS_PATH = "/etc/yurt-pkg/trusted-repos.toml";
export const TRUST_ROOT_PATH =
  "/etc/yurt-pkg/sigstore-trust-root/trusted_root.json";

/** Each run's copy of the repository and its configuration, removed once
 * `pkg` is done with it. One path for every run (the page runs one install
 * at a time): the repository's URL in pkg's cache then stays the same, and
 * pkg does not warn that it changed. */
export const STAGING_DIR = "/var/cache/yurt-pkg/browser/staging";

/** The browser installs' repository cache, apart from the image's default
 * one, so that a cache the image may ship cannot refuse the first install
 * as a rollback. */
export const CACHE_ROOT = "/var/cache/yurt-pkg/browser-repos";

/** A tablet tab runs out of memory well before a desktop one does (#200):
 * there, an install whose downloads (archives, signatures, index and
 * metadata) add up to more than this is refused. */
export const TABLET_MAX_BYTES = 16 * 1024 * 1024;

/** The most one install downloads on any device: the archives are held in
 * the tab while they are staged, then unpacked into the same memory. */
export const INSTALL_MAX_BYTES = 256 * 1024 * 1024;

export type IndexEntry = { sha256: string; size: number; url: string };

export type RepoIndex = {
  schema: number;
  index_version: number;
  expires_at: string;
  packages: Record<string, IndexEntry>;
};

export type PackageVersion = {
  version: string;
  build: string;
  url: string;
  sha256: string;
  size: number;
  depends?: { name: string; req: string }[];
  yanked: boolean;
};

export type PackageFile = { name: string; versions: PackageVersion[] };

/** One archive an install needs. */
export type Release = PackageVersion & { name: string };

/** A package name as `pkg` accepts one (yurt-pkg-format's rule): safe as
 * one path segment and as a shell word. */
const NAME = /^[a-z0-9][a-z0-9._-]*$/;

export function isPackageName(name: string): boolean {
  return NAME.test(name);
}

/** A repository-relative path the index or metadata names, which the page
 * stages at the same path pkg's URL join reads: no leading slash, no `..`,
 * and none of the characters a URL reads differently from a file name --
 * `%` (an encoded `..` resolves as one), `?` and `#` (a query or fragment
 * pkg drops), `:` (a scheme, which pkg takes as an absolute URL), and
 * spaces and control characters (URL parsers strip tabs and newlines). */
function checkRelative(path: string, what: string): string {
  if (
    path === "" || path.startsWith("/") ||
    // deno-lint-ignore no-control-regex
    /[\\%?#:\x00-\x20\x7f]/.test(path) ||
    path.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`${what}: unsupported path ${JSON.stringify(path)}`);
  }
  return path;
}

export function parseIndex(bytes: Uint8Array): RepoIndex {
  const index = JSON.parse(new TextDecoder().decode(bytes)) as RepoIndex;
  if (
    index?.schema !== 1 || typeof index.packages !== "object" ||
    index.packages === null
  ) {
    throw new Error("index.json: not a schema 1 package index");
  }
  for (const [name, entry] of Object.entries(index.packages)) {
    if (!isPackageName(name)) {
      throw new Error(`index.json: bad package name ${JSON.stringify(name)}`);
    }
    if (typeof entry?.url !== "string") {
      throw new Error(`index.json: ${name} has no url`);
    }
    // pkg also takes an absolute metadata URL, but the page stages every
    // metadata file in the copy `pkg update` reads, so an index that uses
    // one cannot be installed from in the browser at all.
    checkRelative(entry.url, `index.json ${name}`);
  }
  return index;
}

export function parsePackageFile(bytes: Uint8Array): PackageFile {
  const file = JSON.parse(new TextDecoder().decode(bytes)) as PackageFile;
  if (typeof file?.name !== "string" || !Array.isArray(file.versions)) {
    throw new Error("package metadata: missing name or versions");
  }
  // A release the page cannot read is left out of the list, not fatal to
  // it; a plan that names it then fails that install alone.
  // The size: the limits and every download's bound count on it.
  file.versions = file.versions.filter((v) =>
    typeof v?.version === "string" && typeof v.build === "string" &&
    typeof v.url === "string" &&
    typeof v.sha256 === "string" && Number.isSafeInteger(v.size) &&
    v.size >= 0
  );
  return file;
}

/** A release the page can download: a repository-relative URL (pkg also
 * takes absolute ones, which the page does not fetch). Checked per
 * release, so one the page cannot fetch fails only its own installs. */
function checkRelease(release: Release): Release {
  checkRelative(release.url, `${release.name} ${release.version}`);
  return release;
}

/** Version order for the list's "latest" column: the numbers, then a
 * pre-release below its release. What gets installed is `pkg`'s choice. */
function compareVersions(a: string, b: string): number {
  const split = (v: string) => {
    const [core, pre] = v.split("+")[0].split(/-(.*)/s);
    return {
      core: core.split(".").map((part) => Number.parseInt(part, 10) || 0),
      pre: pre === undefined ? [] : pre.split("."),
    };
  };
  const va = split(a);
  const vb = split(b);
  for (let i = 0; i < Math.max(va.core.length, vb.core.length); i++) {
    const d = (va.core[i] ?? 0) - (vb.core[i] ?? 0);
    if (d !== 0) return d;
  }
  if (va.pre.length === 0 || vb.pre.length === 0) {
    return vb.pre.length - va.pre.length;
  }
  for (let i = 0; i < Math.max(va.pre.length, vb.pre.length); i++) {
    const x = va.pre[i];
    const y = vb.pre[i];
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny && Number(x) !== Number(y)) return Number(x) - Number(y);
    if (nx !== ny) return nx ? -1 : 1;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** `pkg`'s build order: `yurt_N` by N; any other spelling counts as 0. */
function buildNumber(build: string): number {
  const match = /^yurt_(\d+)$/.exec(build);
  return match === null ? 0 : Number(match[1]);
}

function compareReleases(a: PackageVersion, b: PackageVersion): number {
  return compareVersions(a.version, b.version) ||
    buildNumber(a.build) - buildNumber(b.build);
}

/** The release the list shows: the highest version, then the highest
 * build, never a yanked one. */
export function latestRelease(file: PackageFile): Release | undefined {
  const candidates = file.versions.filter((version) => !version.yanked);
  if (candidates.length === 0) return undefined;
  const best = candidates.reduce((a, b) => compareReleases(a, b) >= 0 ? a : b);
  return { ...best, name: file.name };
}

type TomlRepo = { lines: string[]; values: Record<string, string> };

/** The `[[repo]]` tables of a `trusted-repos.toml`, kept as their lines.
 * Only what the file format needs: a `[[repo]]` header, then `key = value`
 * lines with basic strings (no escapes) or integers. Anything else is refused rather
 * than guessed at. */
function repoTables(toml: string): TomlRepo[] {
  const repos: TomlRepo[] = [];
  for (const raw of toml.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    if (line === "[[repo]]") {
      repos.push({ lines: [], values: {} });
      continue;
    }
    // Strings without escapes: TOML's and JSON's escapes differ.
    const match = /^([A-Za-z0-9_-]+)\s*=\s*("[^"\\]*"|-?\d+)\s*(#.*)?$/
      .exec(line);
    const current = repos.at(-1);
    if (match === null || current === undefined) {
      throw new Error(
        `${TRUSTED_REPOS_PATH}: cannot read ${JSON.stringify(line)}`,
      );
    }
    current.lines.push(`${match[1]} = ${match[2]}`);
    current.values[match[1]] = match[2].startsWith('"')
      ? JSON.parse(match[2])
      : match[2];
  }
  return repos;
}

/**
 * The trust configuration for one install: the image's entry for
 * YurtOS/yurt-packages -- its id, priority, signing subject and issuer,
 * verbatim -- with only the URL pointed at the staged copy. The signing
 * identity is what `pkg` verifies against; the URL only says where the
 * bytes are.
 */
export function browserTrustedRepos(
  toml: string,
  mirrorUrl: string,
): { toml: string; id: string } {
  const repo = repoTables(toml).find((table) => {
    const segments = (table.values.url ?? "").split("/");
    return segments.some((segment, i) =>
      segment === TRUSTED_REPO[0] && segments[i + 1] === TRUSTED_REPO[1]
    );
  });
  if (repo === undefined) {
    throw new Error(
      `${TRUSTED_REPOS_PATH} does not trust ${TRUSTED_REPO.join("/")}`,
    );
  }
  for (const key of ["id", "signing_subject", "signing_issuer"]) {
    if (!repo.values[key]) {
      throw new Error(`${TRUSTED_REPOS_PATH}: the repo has no ${key}`);
    }
  }
  // pkg's own rule for an id, which names its cache directory.
  if (!isPackageName(repo.values.id)) {
    throw new Error(`${TRUSTED_REPOS_PATH}: bad repo id`);
  }
  const lines = repo.lines.map((line) =>
    line.startsWith("url ") ? `url = ${JSON.stringify(mirrorUrl)}` : line
  );
  return { toml: ["[[repo]]", ...lines, ""].join("\n"), id: repo.values.id };
}

function q(word: string): string {
  return `'${word.replace(/'/g, "'\\''")}'`;
}

/**
 * The script the guest runs, as the login user, once the staged copy is in
 * `dir`: `pkg` writes where only root may, so it runs under `sudo`, as the
 * user would type it. The image's trust root goes next to the install's own
 * configuration; `pkg update` runs unless pkg's cache already holds this
 * very index (pkg refuses an index no newer than its cache, its rollback
 * protection, so the same one is not offered twice); then `pkg install`;
 * and the staged copy is removed whatever happened, so the archives do not
 * stay in memory next to what they unpacked to. `sudo` must give root: a
 * stand-in that runs the command as the caller would fail every write.
 */
export function installScript(
  specs: string | readonly string[],
  repoId: string,
): string {
  const words = (typeof specs === "string" ? [specs] : specs).map(q).join(" ");
  const dir = STAGING_DIR;
  const etc = `${dir}/etc`;
  const cached = `${CACHE_ROOT}/${repoId}/current/index.json`;
  const pkg = `sudo pkg --etc-root ${q(etc)} --cache-root ${q(CACHE_ROOT)}`;
  return [
    `cleanup() { sudo rm -rf ${q(dir)}; rm -f "$err"; }`,
    "trap cleanup EXIT",
    "err=$(mktemp) || exit 1",
    "for tool in pkg sudo; do command -v $tool >/dev/null 2>&1 || " +
    '{ echo "this image has no $tool" >&2; exit 127; }; done',
    '[ "$(sudo id -u)" = 0 ] || ' +
    "{ echo 'sudo does not give root here' >&2; exit 126; }",
    `sudo mkdir -p ${q(`${etc}/yurt-pkg/sigstore-trust-root`)} || exit 1`,
    `sudo cp ${q(TRUST_ROOT_PATH)} ${
      q(`${etc}/yurt-pkg/sigstore-trust-root/trusted_root.json`)
    } || exit 1`,
    `if ! sudo cmp -s ${q(cached)} ${q(`${dir}/repo/index.json`)}; then`,
    `  ${pkg} update || exit 1`,
    "fi",
    `${pkg} install ${words} 2>"$err"`,
    "s=$?",
    'cat "$err" >&2',
    // The cached index is this one, but under another signing identity (a
    // restored sandbox, a changed image): pkg wants an update first, which
    // a changed identity lets through at the same version.
    `if [ $s -ne 0 ] && grep -q 'trusted config for repo .* changed' "$err"; then`,
    `  ${pkg} update || exit 1`,
    `  ${pkg} install ${words}`,
    "  exit $?",
    "fi",
    "exit $s",
  ].join("\n");
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

/** Why an install of `bytes` is refused on this device, if it is. */
export function sizeRefusal(
  bytes: number,
  tablet: boolean,
): string | undefined {
  if (tablet && bytes > TABLET_MAX_BYTES) {
    return `${
      formatBytes(bytes)
    } is more than a tablet or phone tab has memory for ` +
      `(the limit here is ${formatBytes(TABLET_MAX_BYTES)}); ` +
      "use a desktop browser or the desktop app";
  }
  if (bytes > INSTALL_MAX_BYTES) {
    return `${formatBytes(bytes)} is more than one tab installs ` +
      `(the limit is ${formatBytes(INSTALL_MAX_BYTES)}); use the desktop app`;
  }
  return undefined;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

/** A file for the guest: its path under the staged copy, and its bytes. */
export type StagedFile = { path: string; bytes: Uint8Array };

/** Whether every file is inside {@link STAGING_DIR}: what the worker
 * checks before it writes them as root. */
export function onlyStaged(files: StagedFile[]): boolean {
  return files.every((file) =>
    file.path.startsWith(`${STAGING_DIR}/`) &&
    !file.path.slice(STAGING_DIR.length + 1).split("/").some((part) =>
      part === "" || part === "." || part === ".."
    )
  );
}

/** What an install needs from the sandbox: a guest file read as the login
 * user, and the staged files written (root's: out of reach of an
 * unprivileged process, though not of `sudo`; pkg's signature checks are
 * the defence) then the script run as the login user. Every staged file
 * is under {@link STAGING_DIR}; the script removes it, and the host
 * removes it again after the run, in case the script never ran or was
 * killed. */
export type PackageHost = {
  readFile(path: string): Promise<Uint8Array>;
  stageAndRun(
    files: StagedFile[],
    script: string,
  ): Promise<{ code: number | null; stdout: string; stderr: string }>;
};

export type Fetcher = (
  url: string,
  limit: number,
  onBytes?: (received: number) => void,
) => Promise<Uint8Array>;

/** The most an index, a signature or a package's metadata may be: they are
 * a few KiB. */
const METADATA_MAX_BYTES = 4 * 1024 * 1024;

/** `fetch` with progress, failing unless the response is OK, and as soon as
 * the response passes `limit` bytes, so a response larger than the index
 * says is never held whole (the tablet limit counts on it). */
export const fetchWithProgress: Fetcher = async (url, limit, onBytes) => {
  const response = await fetch(url, { cache: "no-cache" });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const chunks: Uint8Array[] = [];
  let received = 0;
  const reader = response.body!.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;
    if (received > limit) {
      await reader.cancel();
      throw new Error(`${url}: larger than ${limit} bytes`);
    }
    onBytes?.(received);
  }
  const out = new Uint8Array(received);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
};

export type Catalog = {
  index: RepoIndex;
  indexBytes: Uint8Array;
  /** Fetched together with the index, not when the files are staged, so a
   * republish in between cannot pair them. (Right after a
   * publish, the host's CDN can still serve files from both commits for a
   * few minutes; `pkg` refuses such a mix, and a retry later works.) */
  indexBundle: Uint8Array;
  metadata: Map<string, { bytes: Uint8Array; file: PackageFile }>;
};

/** The repository's index, its signature and every package's metadata: a
 * few KiB, all of which `pkg update` reads. */
export async function loadCatalog(
  fetcher: Fetcher = fetchWithProgress,
  base: string = PACKAGE_REPO_URL,
): Promise<Catalog> {
  const [indexBytes, indexBundle] = await Promise.all([
    fetcher(`${base}index.json`, METADATA_MAX_BYTES),
    fetcher(`${base}index.json.bundle`, METADATA_MAX_BYTES),
  ]);
  const index = parseIndex(indexBytes);
  const metadata = new Map<string, { bytes: Uint8Array; file: PackageFile }>();
  await Promise.all(
    Object.entries(index.packages).map(async ([name, entry]) => {
      const bytes = await fetcher(`${base}${entry.url}`, METADATA_MAX_BYTES);
      metadata.set(name, { bytes, file: parsePackageFile(bytes) });
    }),
  );
  return { index, indexBytes, indexBundle, metadata };
}

/** What the menu lists for each package: its latest release and size. */
export function catalogRows(catalog: Catalog): {
  name: string;
  version: string;
  size: number;
}[] {
  return [...catalog.metadata.entries()]
    .map(([name, { file }]) => ({ name, release: latestRelease(file) }))
    .filter((row) => row.release !== undefined)
    .map(({ name, release }) => ({
      name,
      version: `${release!.version}-${release!.build}`,
      size: release!.size,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** `pkg`'s cause for a failure: it names the cause first and sums up last
 * ("one or more repository updates failed"), so the first line that fails
 * is the one. */
function failure(
  name: string,
  result: { code: number | null; stdout: string; stderr: string },
): Error {
  // stderr first: stdout repeats the plan, whose package names may say
  // "error" (libgpg-error). pkg's warnings ("transaction ... is failed")
  // are not the cause; its own error is the line it starts with "Error:",
  // or a "failed to ..." line it prints before summing up.
  const lines = `${result.stderr}\n${result.stdout}`.split("\n")
    .filter((line) =>
      line.trim() !== "" && !/^install \S+ \S+$/.test(line) &&
      !line.startsWith("warning:")
    );
  const cause = lines.find((line) => /fail|error/i.test(line)) ??
    lines.at(0);
  return new Error(
    `pkg install ${name} failed: ${cause ?? `exit ${result.code}`}`,
  );
}

/** The releases a `pkg install` plan names: it prints `install NAME
 * VERSION-BUILD` for each before it fetches any archive. With `pinned`,
 * every one must be the exact release pinned for its name: a newer build,
 * a republished one, or a dependency the train did not pin is refused
 * before anything is downloaded. */
function planReleases(
  stdout: string,
  catalog: Catalog,
  pinned?: ReadonlyMap<string, PinnedRelease>,
  /** A set's install: a release pkg adds outside the set (a dependency,
   * say a newer ca-certificates) is pkg's to choose, and its to verify. */
  othersAllowed = false,
): Release[] {
  return [...stdout.matchAll(/^install (\S+) (\S+)$/gm)].map(([, n, vb]) => {
    const release = catalog.metadata.get(n)?.file.versions.find((v) =>
      `${v.version}-${v.build}` === vb
    );
    if (release === undefined) {
      throw new Error(
        `pkg chose ${n} ${vb}, which the index does not list or the page cannot read`,
      );
    }
    if (pinned !== undefined) {
      const pin = pinned.get(n);
      if (pin === undefined) {
        if (othersAllowed) return checkRelease({ ...release, name: n });
        throw new Error(`pkg chose ${n} ${vb}, which this page does not pin`);
      }
      if (
        `${pin.version}-${pin.build}` !== vb ||
        release.sha256.toLowerCase() !== pin.sha256 ||
        release.size !== pin.size
      ) {
        throw new Error(
          `${n} ${vb} in the repository is not the ${pin.version}-${pin.build} this page was tested with`,
        );
      }
    }
    return checkRelease({ ...release, name: n });
  });
}

/** One release a page pins (artifacts/pins.json `packages`). */
export type PinnedRelease = {
  name: string;
  version: string;
  build: string;
  sha256: string;
  size: number;
};

/** What `installPackage` installs: a package by name, `pkg`'s choice of
 * release, or a set of exact releases in one `pkg install`, under one
 * label for the progress messages. */
export type InstallRequest =
  | string
  | { label: string; releases: readonly PinnedRelease[] }
  // A set of packages that share one `yurt_N` build, their set's marker:
  // the newest build every one of them has (src/python_install.ts).
  | { label: string; set: readonly string[] };

/** The newest complete set: for each `yurt_N` build every package in
 * `names` has (unyanked, in a release the page can read), the highest N
 * wins, and each package's release with that build (the highest version,
 * should there be several). A set only partly published is never chosen. */
export function resolveSet(
  catalog: Catalog,
  names: readonly string[],
): PinnedRelease[] {
  const byName = names.map((name) => {
    const file = catalog.metadata.get(name)?.file;
    if (file === undefined) throw new Error(`no package named ${name}`);
    return file.versions.filter((v) => !v.yanked && /^yurt_\d+$/.test(v.build));
  });
  const builds = byName.map((versions) =>
    new Set(versions.map((v) => buildNumber(v.build)))
  );
  const common = [...builds[0]].filter((n) => builds.every((b) => b.has(n)));
  if (common.length === 0) {
    throw new Error(
      `the repository has no complete set of ${
        names.join(", ")
      } (one yurt_N build of all of them)`,
    );
  }
  const newest = Math.max(...common);
  return names.map((name, i) => {
    const release = byName[i]
      .filter((v) => buildNumber(v.build) === newest)
      .reduce((a, b) => compareReleases(a, b) >= 0 ? a : b);
    return {
      name,
      version: release.version,
      build: release.build,
      sha256: release.sha256.toLowerCase(),
      size: release.size,
    };
  });
}

/** Where archives and their signatures are kept between visits (the Cache
 * API in the browser), keyed by the archive's sha256 in the signed index
 * (`sha256:<hex>` and `sha256:<hex>.bundle`): one archive is one entry
 * whatever its URL, and a new set's are new entries. What it returns is
 * checked like a download: the archive against that sha256, the signature
 * by the guest's `pkg`. */
export type ArchiveCache = {
  get(key: string): Promise<Uint8Array | undefined>;
  put(key: string, bytes: Uint8Array): Promise<void>;
  delete(key: string): Promise<void>;
  /** Drop every entry but these: what an installed set no longer uses. */
  keepOnly?(keys: readonly string[]): Promise<void>;
};

/** The Cache API wants request URLs; the keys are not fetched. */
const CACHE_KEY_ORIGIN = "https://yurt-packages-cache.invalid/";

/** The Cache API's {@link ArchiveCache}, or none where there is no Cache
 * API (or it refuses: a private window, storage turned off). */
export async function browserArchiveCache(
  name = "yurt-packages-v1",
): Promise<ArchiveCache | undefined> {
  if (typeof caches === "undefined") return undefined;
  let cache: Cache;
  try {
    cache = await caches.open(name);
  } catch {
    return undefined;
  }
  const url = (key: string) => `${CACHE_KEY_ORIGIN}${key}`;
  return {
    async get(key) {
      try {
        const hit = await cache.match(url(key));
        return hit === undefined
          ? undefined
          : new Uint8Array(await hit.arrayBuffer());
      } catch {
        return undefined;
      }
    },
    async put(key, bytes) {
      try {
        await cache.put(
          url(key),
          new Response(bytes.slice() as BufferSource),
        );
      } catch {
        // A full or refused cache only costs the next visit a download.
      }
    },
    async delete(key) {
      try {
        await cache.delete(url(key));
      } catch {
        // As above.
      }
    },
    async keepOnly(keys) {
      const keep = new Set(keys.map(url));
      try {
        for (const request of await cache.keys()) {
          if (!keep.has(request.url)) await cache.delete(request);
        }
      } catch {
        // As above.
      }
    },
  };
}

/**
 * Install `name`: download what it needs, stage it, and let the guest's
 * `pkg` verify and install it. Resolves with `pkg`'s output; throws with
 * the reason when anything refuses.
 *
 * Two runs of `pkg install`. The first has the index and metadata but no
 * archive: `pkg` resolves the install with its own resolver, prints the
 * plan, and stops at the first archive it cannot fetch, before any install
 * transaction starts. (It has run `pkg update`, and taken the installed
 * state's lock, which also resumes transactions an earlier install left
 * prepared.) The page downloads exactly those archives, and the second run
 * installs them.
 */
export async function installPackage(
  request: InstallRequest,
  options: {
    host: PackageHost;
    tablet: boolean;
    progress: (message: string) => void;
    fetcher?: Fetcher;
    base?: string;
    cache?: ArchiveCache;
  },
): Promise<string> {
  const { host, progress, cache } = options;
  const fetcher = options.fetcher ?? fetchWithProgress;
  const base = options.base ?? PACKAGE_REPO_URL;
  const names = typeof request === "string"
    ? [request]
    : "set" in request
    ? [...request.set]
    : request.releases.map((release) => release.name);
  const name = typeof request === "string" ? request : request.label;
  if (names.length === 0 || !names.every(isPackageName)) {
    throw new Error(`not a package name: ${JSON.stringify(names)}`);
  }
  progress(`${name}: reading the package index`);
  // Fresh for every install: a few KiB, and a retry after a failed one
  // must not stage the same bytes again.
  const catalog = await loadCatalog(fetcher, base);
  for (const wanted of names) {
    if (catalog.index.packages[wanted] === undefined) {
      throw new Error(`no package named ${wanted}`);
    }
  }
  // The exact releases, for a set or a pinned list: pkg installs exactly
  // those (`name@version-build`). A pinned list's plan may hold nothing
  // else; a set's may also hold the dependencies pkg adds outside it.
  const exact = typeof request === "string"
    ? undefined
    : "set" in request
    ? resolveSet(catalog, request.set)
    : request.releases;
  const pinned = exact === undefined
    ? undefined
    : new Map(exact.map((release) => [release.name, release]));
  const specs = exact === undefined
    ? [request as string]
    : exact.map((r) => `${r.name}@${r.version}-${r.build}`);
  const command = `pkg install ${specs.join(" ")}`;
  const trusted = new TextDecoder().decode(
    await host.readFile(TRUSTED_REPOS_PATH).catch(() => {
      throw new Error(
        `this image has no ${TRUSTED_REPOS_PATH}, so it cannot install packages`,
      );
    }),
  );
  /** Stage the repository copy, with `archives` (by repository path), and
   * run `pkg` on it. */
  const run = (archives: Map<string, Uint8Array>) => {
    const dir = STAGING_DIR;
    const mirror = `${dir}/repo`;
    const config = browserTrustedRepos(trusted, `file://${mirror}/`);
    // Copies: the catalog keeps its own, and staged files are transferred.
    const files: StagedFile[] = [
      { path: `${mirror}/index.json`, bytes: catalog.indexBytes.slice() },
      {
        path: `${mirror}/index.json.bundle`,
        bytes: catalog.indexBundle.slice(),
      },
      {
        path: `${dir}/etc/yurt-pkg/trusted-repos.toml`,
        bytes: new TextEncoder().encode(config.toml),
      },
    ];
    for (const [dep, entry] of Object.entries(catalog.index.packages)) {
      files.push({
        path: `${mirror}/${entry.url}`,
        bytes: catalog.metadata.get(dep)!.bytes.slice(),
      });
    }
    for (const [path, bytes] of archives) {
      files.push({ path: `${mirror}/${path}`, bytes });
    }
    return host.stageAndRun(files, installScript(specs, config.id));
  };
  progress(`${name}: resolving (${command})`);
  const planned = await run(new Map());
  if (planned.code === 0) return `${planned.stdout}${planned.stderr}`.trim();
  const releases = planReleases(
    planned.stdout,
    catalog,
    pinned,
    typeof request !== "string" && "set" in request,
  );
  if (
    releases.length === 0 ||
    !planned.stderr.includes("failed to fetch archive")
  ) {
    throw failure(name, planned);
  }
  const total = releases.reduce((sum, release) => sum + release.size, 0);
  // The signatures first: they are small, and with the index and metadata
  // they count against the limits too.
  const archives = new Map<string, Uint8Array>();
  /** What came from or went into the cache unchecked by pkg: dropped
   * again if the install fails, so the next try downloads it. */
  const fromCache: string[] = [];
  /** Every cache entry this install uses. */
  const used: string[] = [];
  for (const release of releases) {
    const key = `sha256:${release.sha256.toLowerCase()}.bundle`;
    used.push(key);
    let bundle = await cache?.get(key);
    if (bundle === undefined) {
      bundle = await fetcher(
        `${base}${release.url}.bundle`,
        METADATA_MAX_BYTES,
      );
      await cache?.put(key, bundle);
    }
    // A signature is only known good once pkg has verified it.
    fromCache.push(key);
    archives.set(`${release.url}.bundle`, bundle);
  }
  const staged = [...archives.values()].reduce((s, b) => s + b.byteLength, 0) +
    catalog.indexBytes.byteLength + catalog.indexBundle.byteLength +
    [...catalog.metadata.values()].reduce((s, m) => s + m.bytes.byteLength, 0);
  const refusal = sizeRefusal(total + staged, options.tablet);
  if (refusal !== undefined) throw new Error(`${name}: ${refusal}`);
  let done = 0;
  for (const release of releases) {
    const url = `${base}${release.url}`;
    const key = `sha256:${release.sha256.toLowerCase()}`;
    used.push(key);
    const matches = async (bytes: Uint8Array) =>
      bytes.byteLength === release.size &&
      await sha256Hex(bytes) === release.sha256.toLowerCase();
    // A cached archive is used only if it is still exactly this release.
    let bytes = await cache?.get(key);
    if (bytes !== undefined && await matches(bytes)) {
      fromCache.push(key);
      progress(`${name}: ${release.name} is cached`);
    } else {
      if (bytes !== undefined) await cache?.delete(key);
      const show = (received: number) =>
        progress(
          `${name}: downloading ${release.name} ${
            formatBytes(done + received)
          } of ${formatBytes(total)}`,
        );
      show(0);
      bytes = await fetcher(url, release.size, show);
      if (bytes.byteLength !== release.size) {
        throw new Error(
          `${release.name}: downloaded ${bytes.byteLength} bytes, the index says ${release.size}`,
        );
      }
      if (!await matches(bytes)) {
        throw new Error(
          `${release.name}: the download does not match its sha256`,
        );
      }
      await cache?.put(key, bytes);
    }
    archives.set(release.url, bytes);
    done += release.size;
  }
  progress(`${name}: verifying and installing (${command})`);
  const result = await run(archives);
  if (result.code !== 0) {
    // Whatever was cached may be what pkg refused: the next try downloads.
    for (const key of fromCache) await cache?.delete(key);
    throw failure(name, result);
  }
  // A set replaces the one before it: keep only what this one used.
  if (typeof request !== "string" && "set" in request) {
    await cache?.keepOnly?.(used);
  }
  return `${result.stdout}${result.stderr}`.trim();
}
