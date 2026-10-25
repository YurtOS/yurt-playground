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

/** The origins `connect-src` must allow for {@link PACKAGE_REPO_URL}. */
export const PACKAGE_ORIGINS = ["https://raw.githubusercontent.com"];

/** The repository the image's trust configuration must name: the one entry
 * of `trusted-repos.toml` whose signing identity the browser copy reuses. */
const TRUSTED_REPO_MARK = "YurtOS/yurt-packages";

/** The image's `pkg` configuration (yurt-pkg docs/pkg.md, "Trust Inputs"). */
export const TRUSTED_REPOS_PATH = "/etc/yurt-pkg/trusted-repos.toml";
export const TRUST_ROOT_PATH =
  "/etc/yurt-pkg/sigstore-trust-root/trusted_root.json";

/** Each install's copy of the repository and its configuration, removed
 * once `pkg` is done with it. */
export const STAGING_ROOT = "/var/cache/yurt-pkg/browser";

/** The index version `pkg update` last accepted in this sandbox. `pkg`
 * refuses an index no newer than its cache (rollback protection), so the
 * same index is not offered twice; its cached copy serves the next install. */
export const UPDATED_MARKER = "/var/lib/yurt-pkg/browser-index-version";

/** A tablet tab runs out of memory well before a desktop one does (#200):
 * there, an install that downloads more than this is refused. */
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
  depends: { name: string; req: string }[];
  yanked: boolean;
};

export type PackageFile = { name: string; versions: PackageVersion[] };

/** One archive an install needs. */
export type Release = PackageVersion & { name: string };

const NAME = /^[a-z0-9][a-z0-9._+-]*$/;

/** A package name as `pkg` accepts one, safe in a path and a shell word. */
export function isPackageName(name: string): boolean {
  return NAME.test(name) && !name.includes("..");
}

/** A repository-relative path the index or metadata names: no scheme, no
 * leading slash, no `..`, nothing that leaves the staged copy. */
function checkRelative(path: string, what: string): string {
  if (
    path === "" || path.startsWith("/") || path.includes("\\") ||
    path.includes("://") ||
    path.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`${what}: unsupported path ${JSON.stringify(path)}`);
  }
  return path;
}

export function parseIndex(bytes: Uint8Array): RepoIndex {
  const index = JSON.parse(new TextDecoder().decode(bytes)) as RepoIndex;
  if (index?.schema !== 1 || typeof index.packages !== "object") {
    throw new Error("index.json: not a schema 1 package index");
  }
  for (const [name, entry] of Object.entries(index.packages)) {
    if (!isPackageName(name)) {
      throw new Error(`index.json: bad package name ${JSON.stringify(name)}`);
    }
    checkRelative(entry.url, `index.json ${name}`);
  }
  return index;
}

export function parsePackageFile(bytes: Uint8Array): PackageFile {
  const file = JSON.parse(new TextDecoder().decode(bytes)) as PackageFile;
  if (typeof file?.name !== "string" || !Array.isArray(file.versions)) {
    throw new Error("package metadata: missing name or versions");
  }
  for (const version of file.versions) {
    checkRelative(version.url, `${file.name} ${version.version}`);
  }
  return file;
}

/** Semantic-version order, as the `semver` crate `pkg` sorts with: the
 * numbers, then a pre-release below its release, its identifiers compared
 * numerically or as text; build metadata does not count. */
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

/** The release `pkg install NAME` picks when nothing constrains it: the
 * highest version, then the highest build, never a yanked one. */
export function latestRelease(file: PackageFile): Release | undefined {
  const candidates = file.versions.filter((version) => !version.yanked);
  if (candidates.length === 0) return undefined;
  const best = candidates.reduce((a, b) => compareReleases(a, b) >= 0 ? a : b);
  return { ...best, name: file.name };
}

/** The archives installing `name` needs: the package and, transitively, the
 * latest release of each dependency, in no particular order. Archives the
 * guest's resolver does not pick are staged for nothing; a pick this does
 * not foresee fails the install in `pkg` with the archive it could not find. */
export async function installClosure(
  index: RepoIndex,
  name: string,
  metadata: (name: string) => Promise<PackageFile>,
): Promise<Release[]> {
  const releases: Release[] = [];
  const seen = new Set<string>();
  const queue = [name];
  while (queue.length > 0) {
    const next = queue.shift()!;
    if (seen.has(next)) continue;
    seen.add(next);
    if (index.packages[next] === undefined) {
      throw new Error(
        next === name
          ? `no package named ${next}`
          : `${name} depends on ${next}, which the repository does not publish`,
      );
    }
    const release = latestRelease(await metadata(next));
    if (release === undefined) {
      throw new Error(`${next} has no release that is not yanked`);
    }
    releases.push(release);
    for (const dep of release.depends) queue.push(dep.name);
  }
  return releases;
}

type TomlRepo = { lines: string[]; values: Record<string, string> };

/** The `[[repo]]` tables of a `trusted-repos.toml`, kept as their lines.
 * Only what the file format needs: a `[[repo]]` header, then `key = value`
 * lines with basic strings or integers. Anything else is refused rather
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
    const match = /^([A-Za-z0-9_-]+)\s*=\s*("(?:[^"\\]|\\.)*"|-?\d+)\s*(#.*)?$/
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
export function browserTrustedRepos(toml: string, mirrorUrl: string): string {
  const repo = repoTables(toml).find((table) =>
    (table.values.url ?? "").includes(TRUSTED_REPO_MARK)
  );
  if (repo === undefined) {
    throw new Error(
      `${TRUSTED_REPOS_PATH} does not trust ${TRUSTED_REPO_MARK}`,
    );
  }
  for (const key of ["id", "signing_subject", "signing_issuer"]) {
    if (!repo.values[key]) {
      throw new Error(`${TRUSTED_REPOS_PATH}: the repo has no ${key}`);
    }
  }
  const lines = repo.lines.map((line) =>
    line.startsWith("url ") ? `url = ${JSON.stringify(mirrorUrl)}` : line
  );
  return ["[[repo]]", ...lines, ""].join("\n");
}

function q(word: string): string {
  return `'${word.replace(/'/g, "'\\''")}'`;
}

/**
 * The script the guest runs, as root, once the staged copy is in `dir`:
 * the image's trust root next to the install's own configuration, `pkg
 * update` unless this index is the one already accepted, `pkg install`,
 * and the staged copy removed whatever happened, so the archives do not
 * stay in memory next to what they unpacked to.
 */
export function installScript(
  dir: string,
  name: string,
  indexVersion: number,
): string {
  const etc = `${dir}/etc`;
  return [
    `cleanup() { rm -rf ${q(dir)}; }`,
    "trap cleanup EXIT",
    "command -v pkg >/dev/null 2>&1 || " +
    "{ echo 'this image has no pkg' >&2; exit 127; }",
    `mkdir -p ${q(`${etc}/yurt-pkg/sigstore-trust-root`)} ${
      q(UPDATED_MARKER.replace(/\/[^/]*$/, ""))
    }`,
    `cp ${q(TRUST_ROOT_PATH)} ${
      q(`${etc}/yurt-pkg/sigstore-trust-root/trusted_root.json`)
    } || exit 1`,
    `if [ "$(cat ${q(UPDATED_MARKER)} 2>/dev/null)" != ${
      q(String(indexVersion))
    } ]; then`,
    `  pkg --etc-root ${q(etc)} update || exit 1`,
    `  echo ${q(String(indexVersion))} > ${q(UPDATED_MARKER)}`,
    "fi",
    `pkg --etc-root ${q(etc)} install ${q(name)}`,
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
    return `${formatBytes(bytes)} is more than a tablet tab has memory for ` +
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

/** What an install needs from the sandbox: a guest file read as the login
 * user, and the staged files written then the script run as root. `dir`
 * holds every staged file; the script removes it, and so must the host
 * when it fails before the script runs. */
export type PackageHost = {
  readFile(path: string): Promise<Uint8Array>;
  stageAndRun(
    files: StagedFile[],
    script: string,
    dir: string,
  ): Promise<{ code: number | null; stdout: string; stderr: string }>;
};

export type Fetcher = (
  url: string,
  onBytes?: (received: number) => void,
) => Promise<Uint8Array>;

/** `fetch` with progress, failing on any status but 200. */
export const fetchWithProgress: Fetcher = async (url, onBytes) => {
  const response = await fetch(url, { cache: "no-cache" });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  if (response.body === null) {
    return new Uint8Array(await response.arrayBuffer());
  }
  const chunks: Uint8Array[] = [];
  let received = 0;
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;
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
  /** Fetched with the index, so the two always match. */
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
    fetcher(`${base}index.json`),
    fetcher(`${base}index.json.bundle`),
  ]);
  const index = parseIndex(indexBytes);
  const metadata = new Map<string, { bytes: Uint8Array; file: PackageFile }>();
  await Promise.all(
    Object.entries(index.packages).map(async ([name, entry]) => {
      const bytes = await fetcher(`${base}${entry.url}`);
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

/** Install `name`: download what it needs, stage it, and let the guest's
 * `pkg` verify and install it. Resolves with `pkg`'s output; throws with
 * the reason when anything refuses. */
export async function installPackage(
  name: string,
  options: {
    host: PackageHost;
    tablet: boolean;
    progress: (message: string) => void;
    fetcher?: Fetcher;
    base?: string;
    catalog?: Catalog;
  },
): Promise<string> {
  const { host, progress } = options;
  const fetcher = options.fetcher ?? fetchWithProgress;
  const base = options.base ?? PACKAGE_REPO_URL;
  if (!isPackageName(name)) {
    throw new Error(`not a package name: ${JSON.stringify(name)}`);
  }
  progress(`${name}: reading the package index`);
  const catalog = options.catalog ?? await loadCatalog(fetcher, base);
  const releases = await installClosure(catalog.index, name, (dep) => {
    const entry = catalog.metadata.get(dep);
    if (entry === undefined) throw new Error(`no metadata for ${dep}`);
    return Promise.resolve(entry.file);
  });
  const total = releases.reduce((sum, release) => sum + release.size, 0);
  const refusal = sizeRefusal(total, options.tablet);
  if (refusal !== undefined) throw new Error(`${name}: ${refusal}`);
  const trusted = await host.readFile(TRUSTED_REPOS_PATH).catch(() => {
    throw new Error(
      `this image has no ${TRUSTED_REPOS_PATH}, so it cannot install packages`,
    );
  });
  const dir = `${STAGING_ROOT}/${crypto.randomUUID()}`;
  const mirror = `${dir}/repo`;
  const files: StagedFile[] = [
    // Copies: the list keeps its own, and the staged files are transferred.
    { path: `${mirror}/index.json`, bytes: catalog.indexBytes.slice() },
    {
      path: `${mirror}/index.json.bundle`,
      bytes: catalog.indexBundle.slice(),
    },
    {
      path: `${dir}/etc/yurt-pkg/trusted-repos.toml`,
      bytes: new TextEncoder().encode(
        browserTrustedRepos(
          new TextDecoder().decode(trusted),
          `file://${mirror}/`,
        ),
      ),
    },
  ];
  for (const [dep, entry] of Object.entries(catalog.index.packages)) {
    const meta = catalog.metadata.get(dep);
    if (meta !== undefined) {
      files.push({ path: `${mirror}/${entry.url}`, bytes: meta.bytes.slice() });
    }
  }
  let done = 0;
  for (const release of releases) {
    const show = (received: number) =>
      progress(
        `${name}: downloading ${release.name} ${
          formatBytes(done + received)
        } of ${formatBytes(total)}`,
      );
    show(0);
    const bytes = await fetcher(`${base}${release.url}`, show);
    if (bytes.byteLength !== release.size) {
      throw new Error(
        `${release.name}: downloaded ${bytes.byteLength} bytes, the index says ${release.size}`,
      );
    }
    if (await sha256Hex(bytes) !== release.sha256) {
      throw new Error(
        `${release.name}: the download does not match its sha256`,
      );
    }
    files.push({ path: `${mirror}/${release.url}`, bytes });
    files.push({
      path: `${mirror}/${release.url}.bundle`,
      bytes: await fetcher(`${base}${release.url}.bundle`),
    });
    done += release.size;
  }
  progress(`${name}: verifying and installing (pkg install ${name})`);
  const result = await host.stageAndRun(
    files,
    installScript(dir, name, catalog.index.index_version),
    dir,
  );
  const output = `${result.stdout}${result.stderr}`.trim();
  if (result.code !== 0) {
    // `pkg` names the cause first and sums up last ("one or more
    // repository updates failed"): the first line that fails is the one.
    const lines = output.split("\n").filter((line) => line.trim() !== "");
    const cause = lines.find((line) => /fail|error/i.test(line)) ??
      lines.at(-1);
    throw new Error(
      `pkg install ${name} failed: ${cause ?? `exit ${result.code}`}`,
    );
  }
  return output;
}
