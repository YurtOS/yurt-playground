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
import {
  INSTALLED_DB_PATH,
  INSTALLED_LIST_PATH,
  type InstalledRelease,
} from "./installed_list.ts";
import { COMMAND_DIRS } from "./image_tools.ts";

/** Where the page fetches the repository from: GitHub's raw file host,
 * which answers with `Access-Control-Allow-Origin: *`. */
export const PACKAGE_REPO_URL =
  "https://raw.githubusercontent.com/YurtOS/yurt-packages/main/";

/** What `connect-src` must allow for {@link PACKAGE_REPO_URL}: that
 * repository's files, not every file the host serves. */
export const PACKAGE_SOURCES = [
  "https://raw.githubusercontent.com/YurtOS/yurt-packages/",
];

/** Where the guest's own `pkg` reaches {@link PACKAGE_REPO_URL} in the
 * tab: the page's package relay on the sandbox's loopback
 * (src/pkg_relay.ts), which fetches each file for it. */
export const PKG_RELAY_PORT = 7417;
export const PKG_RELAY_URL = `http://127.0.0.1:${PKG_RELAY_PORT}/`;

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
export function checkRelative(path: string, what: string): string {
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
  const repo = repoTables(toml).find(isPackageRepo);
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

/** The table for YurtOS/yurt-packages: by its URL's path segments, or at
 * the relay, where the page's boot points it ({@link relayTrustedRepos}). */
function isPackageRepo(table: TomlRepo): boolean {
  const url = table.values.url ?? "";
  if (url === PKG_RELAY_URL) return true;
  const segments = url.split("/");
  return segments.some((segment, i) =>
    segment === TRUSTED_REPO[0] && segments[i + 1] === TRUSTED_REPO[1]
  );
}

/**
 * The image's `trusted-repos.toml` with the YurtOS/yurt-packages entry's
 * `url` pointed at the relay, and nothing else changed: the other tables,
 * comments, and the entry's id and signing identity stay as they are.
 * `undefined` when it already points there (a restored sandbox), or when
 * no entry names the repository: there is nothing to relay for.
 */
export function relayTrustedRepos(toml: string): string | undefined {
  const tables = repoTables(toml);
  const target = tables.findIndex(isPackageRepo);
  if (target < 0 || tables[target].values.url === PKG_RELAY_URL) {
    return undefined;
  }
  let table = -1;
  return toml.split("\n").flatMap((raw) => {
    const line = raw.trim();
    if (line === "[[repo]]") table++;
    if (table !== target || !/^url\s*=/.test(line)) return [raw];
    return [
      "# In the browser playground the page fetches this repository for pkg",
      `# (${PACKAGE_REPO_URL}), through its relay on the sandbox's loopback.`,
      `url = ${JSON.stringify(PKG_RELAY_URL)}`,
    ];
  }).join("\n");
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
    watch?: RunWatch,
  ): Promise<{ code: number | null; stdout: string; stderr: string }>;
  /** The host calls `watch.alive` while the guest is still working on a
   * run (src/session_packages.ts: a heartbeat the script writes, read
   * without the guest's help). Without it nothing can tell a long run
   * from a hung one, so the no-progress check pauses during runs. */
  observesProgress?: boolean;
  /** Run `pkg recover` in the guest, watched like a run: what finishes, or
   * retries, a transaction a run the install gave up on left unfinished
   * (pkg writes each file private first and sets its mode in a later
   * pass, so such a transaction can leave a python3 nobody may run). pkg
   * waits for the lock while that run is still going. Absent: no
   * recovery, and a run given up on is said to leave a sandbox that
   * takes no more installs. */
  recover?(
    watch: RunWatch,
  ): Promise<{ code: number | null; stdout: string; stderr: string }>;
};

/** How an install follows one `pkg` run: `alive` at least every few
 * seconds while the sandbox is still working on it; `signal` aborts once
 * the install has given up on the run (it stopped making progress). */
export type RunWatch = { alive: () => void; signal: AbortSignal };

/** How long an install may go with no progress at all -- no status, no
 * downloaded bytes, no heartbeat from the guest's `pkg` run -- before it
 * is called stalled. Not a time limit: a slow, loaded host that keeps
 * making progress takes as long as it takes (80+ s for Python). The
 * guest's heartbeat comes every 2 s, so this is many missed in a row: a
 * sandbox that stopped answering (yurtos-kernel#4170). */
export const INSTALL_STALL_MS = 60_000;

/** The longest one guest `pkg` run may take, heartbeat or not: the
 * backstop for a `pkg` that is alive but blocked, which keeps the
 * heartbeat going (src/session_packages.ts `withHeartbeat`) and shows no
 * other sign. Wall time, with room for a tab the browser slows down. In
 * desktop Safari 27 on an M-series Mac, Python's install run took
 * 136-157 s with the window in front and 538 s with it minimized
 * (hidden, as on a locked screen); twenty minutes is more than twice
 * that. Guest time is no better a measure: the guest's clock and its
 * `sleep` follow the host's monotonic clock, so the hidden tab still beat
 * every 2.4 s while pkg ran at under a third of its speed. A sandbox that
 * stopped is caught by {@link INSTALL_STALL_MS} long before this. */
export const INSTALL_RUN_CEILING_MS = 20 * 60_000;

/** How often a watched run's status says how long it has been going:
 * the page's own silence deadline (src/install_request.ts
 * `INSTALL_SILENCE_MS`) hears from a run that is still working. */
export const PROGRESS_EVERY_MS = 5000;

/** An install that stopped making progress ({@link INSTALL_STALL_MS}).
 * `inSandbox`: it stopped in the guest's `pkg` run, so the sandbox may no
 * longer answer and a retry needs a fresh one; otherwise it stopped in a
 * download, and the sandbox is as it was. */
export class InstallStalled extends Error {
  readonly inSandbox: boolean;
  /** The run went past {@link INSTALL_RUN_CEILING_MS}, still beating: its
   * `pkg` is alive, and holds pkg's lock. */
  readonly ceiling: boolean;
  /** For a stall in the sandbox, once recovery was tried: whether `pkg
   * recover` then left none of pkg's transactions unfinished, finishing
   * any it found. It says nothing more about the install: recovery may
   * have committed it, or the abandoned run may yet do more. `false`: the
   * sandbox may hold a half-installed package, and needs a fresh one. */
  recovered?: boolean;
  /** Whether `pkg recover` was run at all (set with `recovered`). */
  recoveryRan?: boolean;
  constructor(
    name: string,
    ms: number,
    inSandbox: boolean,
    /** The run went past {@link INSTALL_RUN_CEILING_MS}, beating. */
    ceiling = false,
  ) {
    const seconds = Math.round(ms / 1000);
    super(
      ceiling
        ? `${name}: the install ran past its time limit (the sandbox ` +
          `did not finish it in ${seconds} s)`
        : inSandbox
        ? `${name}: the install stopped making progress (the sandbox's ` +
          `pkg did nothing for ${seconds} s)`
        : `${name}: the download stopped making progress (nothing ` +
          `arrived for ${seconds} s)`,
    );
    this.name = "InstallStalled";
    this.inSandbox = inSandbox;
    this.ceiling = ceiling;
  }

  /** The same stall, with what recovery made of it. `ran: false`: no
   * recovery was run (`why` says why), so nothing was recovered. */
  withRecovery(recovered: boolean, why = "", ran = true): InstallStalled {
    const error = new InstallStalled("", 0, this.inSandbox, this.ceiling);
    const said = why === "" ? "" : ` (${why})`;
    // The next try needs a fresh sandbox: the Python install's Try again
    // starts one, and the Packages panel's reply adds that a reload gives
    // one (src/coordinator_worker.ts `servePackages`).
    const noMore = ", so this sandbox may hold a half-installed package " +
      "and takes no more installs";
    error.message = !ran
      ? `${this.message}; pkg recover was not run${said}${noMore}`
      : recovered
      ? `${this.message}; pkg recover then left none of pkg's ` +
        `transactions unfinished, but the page did not see the install ` +
        `finish, so this sandbox takes no more installs`
      : `${this.message}; pkg recover could not finish what it left ` +
        `unfinished${said}${noMore}`;
    error.recovered = ran && recovered;
    error.recoveryRan = ran;
    return error;
  }
}

/** Why a sandbox takes no more installs after `error`, a stall in its
 * `pkg` run: said with "in this sandbox, so it installs nothing more;
 * reload the page" after it (src/coordinator_worker.ts). */
export function stalledSandboxWhy(error: InstallStalled): string {
  if (error.ceiling) {
    return "an earlier install was still running past its time limit, " +
      "so a package may be half installed";
  }
  if (error.recovered !== false) {
    return "an earlier install stopped making progress";
  }
  return error.recoveryRan === false
    ? "an earlier install stopped part way, so a package may be half " +
      "installed"
    : "an earlier install stopped part way and pkg recover could not " +
      "finish it, so a package may be half installed";
}

/** `pkg recover` after a run the install gave up on, watched like a run:
 * no progress for `stallMs`, or running longer than `ceilingMs`, gives up
 * on it too. While it beats, `status` is said with its seconds every
 * `everyMs`, as a run's is, so the page's own silence deadline
 * (src/install_request.ts) hears from it. Whether it finished, and if
 * not, why. */
async function recoverStalled(
  recover: NonNullable<PackageHost["recover"]>,
  limits: { stallMs: number; ceilingMs: number; everyMs: number },
  status: string,
  progress: (message: string) => void,
): Promise<{ recovered: boolean; why: string }> {
  const { stallMs, ceilingMs, everyMs } = limits;
  const giveUp = new AbortController();
  const started = Date.now();
  let last = started;
  let shown = started;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stopped = new Promise<string>((resolve) => {
    // Said before the abort, which makes the recovery reject at once: the
    // race then answers with why the install gave up on it.
    const stop = (why: string) => {
      resolve(why);
      giveUp.abort();
    };
    const check = () => {
      const now = Date.now();
      // Silence first: a late timer that finds both limits passed has a
      // recovery that stopped beating, not one still at work.
      const idle = now - last;
      if (idle >= stallMs) {
        return stop(`it did nothing for ${Math.round(idle / 1000)} s`);
      }
      if (now - started >= ceilingMs) {
        return stop(`it did not finish in ${Math.round(ceilingMs / 1000)} s`);
      }
      timer = setTimeout(
        check,
        Math.max(Math.min(stallMs - idle, ceilingMs - (now - started)), 10),
      );
    };
    timer = setTimeout(check, Math.min(stallMs, ceilingMs));
  });
  try {
    const outcome = await Promise.race([
      recover({
        alive: () => {
          const now = Date.now();
          last = now;
          if (!giveUp.signal.aborted && now - shown >= everyMs) {
            shown = now;
            progress(`${status} (${Math.round((now - started) / 1000)} s)`);
          }
        },
        signal: giveUp.signal,
      }),
      stopped,
    ]);
    if (typeof outcome === "string") return { recovered: false, why: outcome };
    if (outcome.code === 0) return { recovered: true, why: "" };
    const said = `${outcome.stdout}\n${outcome.stderr}`.trim().split("\n").at(
      -1,
    );
    return {
      recovered: false,
      why: said !== undefined && said !== ""
        ? said
        : outcome.code === null
        ? "it was killed by a signal"
        : `exit ${outcome.code}`,
    };
  } catch (error) {
    return {
      recovered: false,
      why: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
    giveUp.abort();
  }
}

export type Fetcher = (
  url: string,
  limit: number,
  onBytes?: (received: number) => void,
  signal?: AbortSignal,
) => Promise<Uint8Array>;

/** How long past its `expires_at` an index is still accepted: pkg's grace
 * (yurt-pkg `Freshness`). */
const INDEX_GRACE_MS = 30 * 24 * 3600 * 1000;

/** The most an index, a signature or a package's metadata may be: they are
 * a few KiB. */
export const METADATA_MAX_BYTES = 4 * 1024 * 1024;

/** `fetch` with progress, failing unless the response is OK, and as soon as
 * the response passes `limit` bytes, so a response larger than the index
 * says is never held whole (the tablet limit counts on it). */
export const fetchWithProgress: Fetcher = async (
  url,
  limit,
  onBytes,
  signal,
) => {
  const response = await fetch(url, { cache: "no-cache", signal });
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
  /** Also check what `pkg update` would, short of the index's signature:
   * each metadata file against the index's sha256, and that the index has
   * not expired (pkg's 30 days' grace past `expires_at`). For a page that
   * reads archives itself rather than through the guest's `pkg`. */
  checked = false,
  now: Date = new Date(),
): Promise<Catalog> {
  const [indexBytes, indexBundle] = await Promise.all([
    fetcher(`${base}index.json`, METADATA_MAX_BYTES),
    fetcher(`${base}index.json.bundle`, METADATA_MAX_BYTES),
  ]);
  const index = parseIndex(indexBytes);
  if (checked) {
    const expires = Date.parse(index.expires_at);
    if (!Number.isFinite(expires) || now.getTime() > expires + INDEX_GRACE_MS) {
      throw new Error(`the package index expired at ${index.expires_at}`);
    }
  }
  const metadata = new Map<string, { bytes: Uint8Array; file: PackageFile }>();
  await Promise.all(
    Object.entries(index.packages).map(async ([name, entry]) => {
      const bytes = await fetcher(`${base}${entry.url}`, METADATA_MAX_BYTES);
      if (checked && await sha256Hex(bytes) !== entry.sha256?.toLowerCase()) {
        throw new Error(`${entry.url} does not match the index's sha256`);
      }
      metadata.set(name, { bytes, file: parsePackageFile(bytes) });
    }),
  );
  return { index, indexBytes, indexBundle, metadata };
}

/** What a panel install put in: the package, and the dependencies pkg's
 * plan installed with it (its `install NAME VERSION` lines). The panel
 * marks them at once; the next read of pkg's installed list
 * (src/installed_list.ts) replaces the guess. */
export function plannedInstalls(output: string, name: string): string[] {
  const names = new Set(
    [...output.matchAll(/^install (\S+) /gm)].map((match) => match[1]),
  );
  names.add(name);
  return [...names];
}

/** Packages the panel never lists, whatever the sandbox holds, each with
 * why. (What the image already has outside pkg is left out too, but found
 * in the sandbox: {@link packagesInImage}.) */
export const NOT_LISTED: ReadonlyMap<string, string> = new Map([
  [
    "python-seal",
    // Not something to run: the page installs and verifies it itself
    // (src/python_install.ts, src/notebook_kernel_worker.ts).
    "the Suspend/Resume kernel's sealable interpreter, which that kernel fetches itself",
  ],
]);

/** One package's row in the panel, and its Install button. */
export type PackageRow = {
  row: { hidden: boolean };
  button: {
    dataset: { package?: string };
    textContent: string | null;
    disabled: boolean;
  };
};

/** The panel's rows, by what the sandbox is known to have: what pkg
 * installed (`installed`) says Installed and cannot be clicked; what the
 * image has outside pkg (`inImage`, {@link packagesInImage}) and what is
 * {@link NOT_LISTED} is not listed at all; no button can be clicked while
 * an install runs. */
export function markInstalled(
  rows: Iterable<PackageRow>,
  installed: ReadonlySet<string>,
  inImage: ReadonlySet<string>,
  busy: boolean,
): void {
  for (const { row, button } of rows) {
    const name = button.dataset.package ?? "";
    const has = installed.has(name);
    // pkg's list first: a command pkg put there is pkg's, not the image's.
    row.hidden = NOT_LISTED.has(name) || (!has && inImage.has(name));
    button.textContent = has ? "Installed" : "Install";
    button.disabled = busy || has;
  }
}

/**
 * The catalog packages the sandbox already has outside pkg: those whose
 * command is there (src/image_tools.ts) and that pkg's installed list
 * does not name, both read in the same run. The slim image bakes busybox,
 * make, pkg, zsh and zstd into its base without pkg, so pkg refuses to
 * install them ("would overwrite unmanaged path bin/zsh"). The
 * repository's metadata names no files -- each archive's own
 * `info/files.json` does, and clang's archive alone is 94 MB -- so the
 * sandbox is asked about the command instead; for every package published
 * on 2026-10-29 that finds exactly the archives whose files the slim image
 * has. Read once: pkg cannot install over these, and a fresh sandbox boots
 * the same image. With pkg's database but no list (a pkg before
 * yurt-pkg#59), what pkg manages is unknown, so none. `root` is for tests.
 */
export async function packagesInImage(
  names: readonly string[],
  /** A stuck run has no `code`. */
  exec: (cmd: string) => Promise<{ code?: number | null; stdout: string }>,
  root = "",
): Promise<Set<string>> {
  if (names.length === 0) return new Set();
  for (const name of names) {
    // Each goes into the script as a word.
    if (!isPackageName(name)) {
      throw new Error(`${JSON.stringify(name)} is not a package name`);
    }
  }
  const dirs = COMMAND_DIRS.map((dir) => `'${root}${dir}'`).join(" ");
  const list = `'${root}${INSTALLED_LIST_PATH}'`;
  const db = `'${root}${INSTALLED_DB_PATH}'`;
  const result = await exec(
    `if [ -e ${list} ]; then ` +
      `managed=$(cut -f1 ${list}) || exit 3; managed=" $(echo $managed) "; ` +
      `elif [ -e ${db} ]; then exit 0; else managed=" "; fi; ` +
      `for n in ${names.join(" ")}; do ` +
      `case "$managed" in *" $n "*) continue;; esac; ` +
      `for d in ${dirs}; do ` +
      `if [ -f "$d/$n" ] && [ ! -L "$d/$n" ]; then echo "$n"; break; fi; ` +
      `done; done`,
  );
  if (result.code !== 0) {
    throw new Error(
      `could not tell what the image has: exit ${
        result.code ?? "none, the probe did not finish"
      }`,
    );
  }
  const asked = new Set(names);
  return new Set(result.stdout.split("\n").filter((line) => asked.has(line)));
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
          `${n} ${vb} in the repository is not the ${pin.version}-${pin.build} this install expects`,
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
  | {
    label: string;
    releases: readonly PinnedRelease[];
    /** pkg may add releases outside `releases` (dependencies it verifies). */
    othersAllowed?: boolean;
    /** Every release must be fetched and verified now: a plan that names
     * fewer, or a run that installs nothing, is a refusal. */
    verifyAll?: boolean;
  }
  // A set of packages that share one `yurt_N` build, their set's marker:
  // the newest build every one of them has (src/python_install.ts), or the
  // build of the members already `installed` (resolveSet); only the
  // members not installed are asked of pkg.
  | {
    label: string;
    set: readonly string[];
    installed?: readonly InstalledRelease[];
  };

/** The repository does not offer the set: a member it has no package for,
 * or no `yurt_N` build that all of them have. */
export class SetNotOffered extends Error {}

/** The newest complete set: for each `yurt_N` build every package in
 * `names` has (unyanked, in a release the page can read), the highest N
 * wins, and each package's release with that build (the highest version,
 * should there be several). A set only partly published is never chosen.
 *
 * Members already `installed` (pkg's installed list) pin it: pkg never
 * replaces an installed package, so the set is the one at their build,
 * with their exact releases, however much newer a set is live -- and none
 * at all (SetNotOffered, naming them) when the repository no longer has a
 * complete set there. What is installed outside `names` pins nothing. */
export function resolveSet(
  catalog: Catalog,
  names: readonly string[],
  installed: readonly InstalledRelease[] = [],
): (PinnedRelease & { url: string })[] {
  const readable = (name: string, release: PackageVersion) => {
    try {
      checkRelease({ ...release, name });
      return true;
    } catch {
      return false;
    }
  };
  const pins = new Map(
    installed.filter((r) => names.includes(r.name)).map((r) => [r.name, r]),
  );
  const byName = names.map((name) => {
    const file = catalog.metadata.get(name)?.file;
    if (file === undefined) throw new SetNotOffered(`no package named ${name}`);
    const pin = pins.get(name);
    return file.versions.filter((v) =>
      !v.yanked && /^yurt_\d+$/.test(v.build) && readable(name, v) &&
      (pin === undefined ||
        (v.version === pin.version && v.build === pin.build))
    );
  });
  const builds = byName.map((versions) =>
    new Set(versions.map((v) => buildNumber(v.build)))
  );
  const common = [...builds[0]].filter((n) => builds.every((b) => b.has(n)));
  if (common.length === 0) {
    const at = [...pins.values()].map((r) =>
      `${r.name} ${r.version}-${r.build}`
    );
    throw new SetNotOffered(
      at.length === 0
        ? `the repository has no complete set of ${
          names.join(", ")
        } (one yurt_N build of all of them)`
        : `the repository has no complete set of ${
          names.join(", ")
        } at the installed ${
          at.join(", ")
        } (pkg cannot replace an installed package, so only a set of that build can be installed beside it)`,
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
      url: release.url,
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
  options: InstallOptions,
): Promise<string> {
  const name = typeof request === "string" ? request : request.label;
  const stallMs = options.stallMs ?? INSTALL_STALL_MS;
  const ceilingMs = options.runCeilingMs ?? INSTALL_RUN_CEILING_MS;
  /** When the watched run in flight started. */
  let runStarted: number | undefined;
  let last = Date.now();
  /** Runs in flight that nothing can watch: the check waits for them. */
  let unwatched = 0;
  /** Watched runs in flight: a stall then is the sandbox's. */
  let watched = 0;
  const touch = () => {
    last = Date.now();
  };
  const giveUp = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** Give up if the install has stalled; else look again when it next
   * could have. Set by the promise below, synchronously. */
  let check = () => {};
  const stalled = new Promise<never>((_, reject) => {
    check = () => {
      if (giveUp.signal.aborted) return;
      const now = Date.now();
      const idle = now - last;
      const running = runStarted === undefined ? 0 : now - runStarted;
      // Past the ceiling and still heard from: a live run. A run also
      // silent for the stall window (a late timer sees both at once) is a
      // stall like any other, which recovery may help.
      if (
        runStarted !== undefined && running >= ceilingMs && idle < stallMs
      ) {
        giveUp.abort();
        reject(new InstallStalled(name, ceilingMs, true, true));
        return;
      }
      if (unwatched === 0 && idle >= stallMs) {
        giveUp.abort();
        reject(new InstallStalled(name, stallMs, watched > 0));
        return;
      }
      const untilCeiling = runStarted === undefined
        ? Infinity
        : ceilingMs - running;
      // An unwatched run touches when it ends: look again a window later.
      const untilIdle = unwatched > 0 ? stallMs : stallMs - idle;
      timer = setTimeout(
        check,
        Math.max(Math.min(untilIdle, untilCeiling), 10),
      );
    };
    timer = setTimeout(check, stallMs);
  });
  const watcher: InstallWatcher = {
    touch,
    signal: giveUp.signal,
    check: () => {
      if (giveUp.signal.aborted) throw new Error(`${name}: given up`);
    },
    watched: async (run) => {
      watched++;
      runStarted = Date.now();
      // The ceiling may come before the next idle check: reschedule.
      clearTimeout(timer);
      check();
      try {
        return await run();
      } finally {
        watched--;
        runStarted = undefined;
      }
    },
    unwatched: async (run) => {
      unwatched++;
      try {
        return await run();
      } finally {
        unwatched--;
        touch();
      }
    },
  };
  try {
    return await Promise.race([
      installWatched(request, {
        ...options,
        // Nothing more is said once the install has given up: the page
        // shows its failure, and maybe a fresh sandbox's progress.
        progress: (message) => {
          if (giveUp.signal.aborted) return;
          touch();
          options.progress(message);
        },
      }, watcher),
      stalled,
    ]);
  } catch (error) {
    // The page gave up on a guest `pkg` run, which may have stopped
    // between writing files and setting their modes: let pkg finish or
    // retry that transaction before the failure is said, so nothing is
    // left half installed and looking installed.
    if (!(error instanceof InstallStalled) || !error.inSandbox) throw error;
    // A sandbox thrown away after this install has nothing to recover.
    if (options.recoverAfterStall === false) throw error;
    if (options.host.recover === undefined) {
      throw error.withRecovery(false, "this sandbox cannot run it", false);
    }
    // A run past the ceiling is still beating: its pkg is alive and holds
    // pkg's lock, which `pkg recover` would wait on -- beating, so for
    // another whole ceiling -- before it could do anything.
    if (error.ceiling) {
      throw error.withRecovery(
        false,
        "the run is still going, and holds pkg's lock",
        false,
      );
    }
    const status = `${name}: running pkg recover after the stopped install`;
    options.progress(status);
    const { recovered, why } = await recoverStalled(
      options.host.recover,
      {
        stallMs,
        ceilingMs,
        everyMs: options.progressEveryMs ?? PROGRESS_EVERY_MS,
      },
      status,
      options.progress,
    );
    throw error.withRecovery(recovered, why);
  } finally {
    clearTimeout(timer);
  }
}

type InstallOptions = {
  host: PackageHost;
  tablet: boolean;
  progress: (message: string) => void;
  fetcher?: Fetcher;
  base?: string;
  cache?: ArchiveCache;
  /** {@link INSTALL_STALL_MS}; shorter in tests. */
  stallMs?: number;
  /** {@link INSTALL_RUN_CEILING_MS}; shorter in tests. */
  runCeilingMs?: number;
  /** Told the exact releases a set or pinned list resolved to, from the
   * install's own index read: what this install puts in the sandbox. */
  resolved?: (releases: readonly PinnedRelease[]) => void;
  /** {@link PROGRESS_EVERY_MS}; shorter in tests. */
  progressEveryMs?: number;
  /** `false` for a sandbox that is thrown away after the install (the
   * Suspend/Resume check): a stall then runs no `pkg recover`, and its
   * error is the stall alone. */
  recoverAfterStall?: boolean;
};

type InstallWatcher = {
  touch(): void;
  signal: AbortSignal;
  /** Throws once the install has given up: it does nothing more. */
  check(): void;
  watched<T>(run: () => Promise<T>): Promise<T>;
  unwatched<T>(run: () => Promise<T>): Promise<T>;
};

async function installWatched(
  request: InstallRequest,
  options: InstallOptions,
  watcher: InstallWatcher,
): Promise<string> {
  const { host, progress, cache } = options;
  const fetchBytes = options.fetcher ?? fetchWithProgress;
  // Every download stops with the install, and none starts after it.
  const fetcher: Fetcher = async (url, limit, onBytes) => {
    watcher.check();
    const bytes = await fetchBytes(url, limit, onBytes, watcher.signal);
    watcher.check();
    return bytes;
  };
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
    ? resolveSet(catalog, request.set, request.installed)
    : request.releases;
  if (exact !== undefined) options.resolved?.(exact);
  const pinned = exact === undefined
    ? undefined
    : new Map(exact.map((release) => [release.name, release]));
  // A set's members already installed (at exactly these releases, which
  // resolveSet made sure of) are not asked for again.
  const have = typeof request !== "string" && "set" in request
    ? new Set((request.installed ?? []).map((r) => r.name))
    : new Set<string>();
  const specs = exact === undefined
    ? [request as string]
    : exact.filter((r) => !have.has(r.name)).map((r) =>
      `${r.name}@${r.version}-${r.build}`
    );
  // Only a set's members can all be installed already: a pinned list (a
  // verify-all one included) names at least one release, or the name
  // check above refused it, and none of its releases is skipped.
  if (specs.length === 0) {
    progress(`${name}: already installed`);
    return "";
  }
  const command = `pkg install ${specs.join(" ")}`;
  // A guest process too: a sandbox that stops answering here is the
  // sandbox's stall, not a download's.
  const trusted = new TextDecoder().decode(
    await watcher.watched(() => host.readFile(TRUSTED_REPOS_PATH)).catch(() => {
      throw new Error(
        `this image has no ${TRUSTED_REPOS_PATH}, so it cannot install packages`,
      );
    }),
  );
  /** Stage the repository copy, with `archives` (by repository path), and
   * run `pkg` on it; `status` is what the page shows meanwhile, with a
   * count of seconds while the guest's heartbeat says it is working. */
  const run = (archives: Map<string, Uint8Array>, status: string) => {
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
    const script = installScript(specs, config.id);
    watcher.check();
    progress(status);
    if (host.observesProgress !== true) {
      return watcher.unwatched(() => host.stageAndRun(files, script));
    }
    const started = Date.now();
    let shown = started;
    const progressEveryMs = options.progressEveryMs ?? PROGRESS_EVERY_MS;
    return watcher.watched(() =>
      host.stageAndRun(files, script, {
        alive: () => {
          watcher.touch();
          const now = Date.now();
          if (now - shown >= progressEveryMs) {
            shown = now;
            progress(`${status} (${Math.round((now - started) / 1000)} s)`);
          }
        },
        signal: watcher.signal,
      })
    );
  };
  const planned = await run(new Map(), `${name}: resolving (${command})`);
  const verifyAll = typeof request !== "string" && "releases" in request &&
    request.verifyAll === true;
  if (planned.code === 0) {
    if (verifyAll) {
      throw new Error(
        `${name}: pkg verified nothing: ${
          specs.join(" ")
        } is already installed`,
      );
    }
    return `${planned.stdout}${planned.stderr}`.trim();
  }
  const releases = planReleases(
    planned.stdout,
    catalog,
    pinned,
    typeof request !== "string" &&
      ("set" in request || request.othersAllowed === true),
  );
  if (
    releases.length === 0 ||
    !planned.stderr.includes("failed to fetch archive")
  ) {
    throw failure(name, planned);
  }
  // After pkg's own refusals: a planning run that failed before printing
  // a plan names its cause, not the pins it did not get to.
  if (verifyAll) {
    const named = new Set(
      releases.map((r) => `${r.name}@${r.version}-${r.build}`),
    );
    const missing = specs.filter((spec) => !named.has(spec));
    if (missing.length > 0) {
      throw new Error(
        `${name}: pkg's plan does not fetch ${
          missing.join(", ")
        }, so it would not verify them`,
      );
    }
  }
  const total = releases.reduce((sum, release) => sum + release.size, 0);
  // What pkg adds to the request (its dependencies), named with its size,
  // so a dependency's download is not taken for pkg's own overhead.
  const extra = releases.filter((release) => !names.includes(release.name));
  if (extra.length > 0) {
    progress(
      `${name}: also installs ${
        extra.map((r) => `${r.name} (${formatBytes(r.size)})`).join(", ")
      }`,
    );
  }
  // The signatures first: they are small, and with the index and metadata
  // they count against the limits too.
  const archives = new Map<string, Uint8Array>();
  /** The signatures this install used, and the archives it read from the
   * cache: unchecked by pkg until it succeeds, so dropped again if the
   * install fails and the next try downloads them. (A downloaded archive
   * stays: the cache is keyed by its sha256, checked on every read.) */
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
          `${name}: downloading ${release.name}${
            extra.includes(release) ? ` (a dependency)` : ""
          } ${formatBytes(done + received)} of ${formatBytes(total)}`,
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
  const result = await run(
    archives,
    `${name}: verifying and installing (${command})`,
  );
  if (result.code !== 0) {
    // Whatever was cached may be what pkg refused: the next try downloads.
    for (const key of fromCache) await cache?.delete(key);
    throw failure(name, result);
  }
  // A set, or a verify-all list (the Suspend/Resume set), replaces the one
  // before it: keep only what this one used.
  if (
    typeof request !== "string" &&
    ("set" in request || request.verifyAll === true)
  ) {
    await cache?.keepOnly?.(used);
  }
  return `${result.stdout}${result.stderr}`.trim();
}

/** One release's archive, checked against the sha256 and size its
 * metadata names (with a catalog loaded `checked`, metadata that matches the
 * index; the index's own signature is not verified here, only by the
 * guest's `pkg`): from `cache` when it holds it, else downloaded (and
 * cached). For a page that reads files out of an archive itself (the
 * Suspend/Resume kernel's interpreter and standard library) rather than
 * installing it. */
export async function fetchRelease(
  release: PinnedRelease & { url: string },
  options: {
    fetcher?: Fetcher;
    base?: string;
    cache?: ArchiveCache;
    progress?: (received: number) => void;
  } = {},
): Promise<Uint8Array> {
  const fetcher = options.fetcher ?? fetchWithProgress;
  const base = options.base ?? PACKAGE_REPO_URL;
  const key = `sha256:${release.sha256.toLowerCase()}`;
  const matches = async (bytes: Uint8Array) =>
    bytes.byteLength === release.size &&
    await sha256Hex(bytes) === release.sha256.toLowerCase();
  const cached = await options.cache?.get(key);
  if (cached !== undefined && await matches(cached)) return cached;
  if (cached !== undefined) await options.cache?.delete(key);
  const bytes = await fetcher(
    `${base}${checkRelative(release.url, release.name)}`,
    release.size,
    options.progress,
  );
  if (!await matches(bytes)) {
    throw new Error(`${release.name}: the download does not match its sha256`);
  }
  await options.cache?.put(key, bytes);
  return bytes;
}
