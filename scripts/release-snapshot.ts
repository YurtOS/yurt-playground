#!/usr/bin/env -S deno run --allow-all
/**
 * release-snapshot.ts -- capture the sealed sandbox `?snapshot=1` restores
 * (src/sandbox_snapshot.ts) for the train artifacts/pins.json names, publish
 * it as a yurt-playground release, and pin it.
 *
 * The snapshot is the kernel's memory after the Python set was installed in
 * the browser, so it is captured by the page itself, locally, in headless
 * Chromium: no CI job builds it. Run it after a train changed the kernel,
 * the image or the Python set (release-playground.sh drops a snapshot pin
 * that no longer matches and says so).
 *
 *   1. serve this checkout (the dev server) and open `/?start&snapshot=capture`:
 *      the page boots the pinned slim image, installs the Python set from
 *      the live repository, precompiles it, seals the sandbox and downloads
 *      the file (public/snapshot/sandbox.seal.gz);
 *   2. check that the file decodes in full and was built from the pins and
 *      from the Python set the live index offers (a capture starts only
 *      when the index answers with a complete set);
 *   3. split it into the site's parts and hash them;
 *   4. create the prerelease `snapshot-<train>` on YurtOS/yurt-playground
 *      (never "latest") with the parts and a .sha256, or find it already
 *      there with the same file (a no-op);
 *   5. write the `snapshot` entry into artifacts/pins.json.
 *
 * Usage: deno run -A scripts/release-snapshot.ts [--dry-run] [--resume] [--tag TAG]
 *        deno run -A scripts/release-snapshot.ts --check-pin [--pins PATH]
 *
 *   --dry-run  everything but the release and the pins write
 *   --resume   reuse public/snapshot/sandbox.seal.gz when it is a capture
 *              of this train and of the live Python set (a capture is never
 *              the same bytes twice, so a release cut by an earlier run
 *              matches only its own file)
 *   --tag      the release tag (default snapshot-<train>): a second snapshot
 *              of one train, e.g. after a BOOT_SETUP bump, takes a new tag
 *              (snapshot-<train>-2); a published release is never replaced
 *   --check-pin  exit 0 when artifacts/pins.json's (or PATH's) snapshot
 *              entry may stay: well formed, this page's format, built from
 *              these pins and of the Python set the live index offers -- or
 *              the index cannot be had (downloaded in time and parsed), as
 *              the page then restores it too; else exit 3 with a
 *              "snapshot pin refused: <reason>"
 *              line on stderr (scripts/lib/snapshot-pin.sh); exit 1 is a
 *              failure to check
 *
 * It refuses to run from a kernel checkout that is not at the pinned rev
 * or a playground checkout that is not its branch's pushed head, either
 * with uncommitted changes.
 *
 * Needs: the pinned blobs (scripts/install-pinned-artifacts.sh), the sibling
 * yurtos-kernel at the pinned rev (the page bundle), Playwright's Chromium
 * (`deno run -A npm:playwright@1.55.0 install chromium`), network access
 * (the page installs Python from YurtOS/yurt-packages), and `gh` with write
 * access to YurtOS/yurt-playground releases.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureBundle, kernelRoot } from "./serve.ts";
import { checkSnapshotFile } from "./lib/snapshot_file.ts";
import {
  livePythonSet,
  NO_COMPLETE_SET,
  pythonInstallRequest,
} from "../src/python_install.ts";
import { handlePlaygroundRequest, ISOLATION_HEADERS } from "../src/serve.ts";
import { imagePartRange, imagePartsManifest } from "../src/image_parts.ts";
import { sha256Hex } from "../src/integrity.ts";
import {
  loadPins,
  parsePins,
  type Pins,
  type SnapshotPin,
} from "../src/pins.ts";
import {
  checkPythonSet,
  FORMAT,
  pinnedSnapshot,
  SANDBOX_SNAPSHOT_NAME,
  snapshotIdentity,
  SnapshotMismatch,
} from "../src/sandbox_snapshot.ts";

const REPO = "YurtOS/yurt-playground";
const ASSET = "sandbox.seal.gz";
/** A capture is a boot, a Python install and a seal: ~2 min on a laptop. */
const CAPTURE_TIMEOUT_MS = 15 * 60_000;

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pinsPath = join(root, "artifacts/pins.json");
const snapshotPath = join(root, "public", SANDBOX_SNAPSHOT_NAME);

const say = (text: string) => console.error(`release-snapshot: ${text}`);
const die = (text: string): never => {
  say(text);
  Deno.exit(1);
};

async function gh(
  args: string[],
  { allowFailure = false } = {},
): Promise<{ ok: boolean; stdout: string }> {
  const out = await new Deno.Command("gh", {
    args,
    stdout: "piped",
    stderr: "piped",
  }).output();
  const stderr = new TextDecoder().decode(out.stderr);
  if (!out.success && !allowFailure) {
    die(`gh ${args.join(" ")} failed: ${stderr}`);
  }
  return { ok: out.success, stdout: new TextDecoder().decode(out.stdout) };
}

/** The variables git itself says point it at a repository
 * (`git rev-parse --local-env-vars`: GIT_DIR, GIT_INDEX_FILE, ...). */
let localGitVariables: Set<string> | undefined;

/** This process's environment without the variables that point git at a
 * repository (a git hook sets GIT_DIR and GIT_INDEX_FILE): git then reads
 * the checkout it is run in, with everything else -- credentials, an SSH
 * agent, a proxy, GIT_ASKPASS, GIT_SSL_CAINFO -- as the caller has it. */
export function withoutGitVariables(): Record<string, string> {
  localGitVariables ??= new Set(
    new TextDecoder().decode(
      new Deno.Command("git", {
        args: ["rev-parse", "--local-env-vars"],
        stdout: "piped",
        stderr: "null",
      }).outputSync().stdout,
    ).split("\n").filter((name) => name !== ""),
  );
  return Object.fromEntries(
    Object.entries(Deno.env.toObject()).filter(([name]) =>
      !localGitVariables!.has(name)
    ),
  );
}

/** Why the checkout at `dir` is not at `rev` with a clean tree (paths in
 * `ignored` aside), or undefined when it is. `rev` "upstream" is its
 * branch's pushed head: no commit the PR that carries the pin lacks. */
export async function checkoutProblem(
  dir: string,
  rev: string,
  ignored: string[] = [],
): Promise<string | undefined> {
  const git = async (...args: string[]) => {
    const out = await new Deno.Command("git", {
      args: ["-C", dir, ...args],
      stdout: "piped",
      stderr: "piped",
      // A hook's GIT_DIR or GIT_INDEX_FILE would point elsewhere: every
      // other variable (an SSH agent, a proxy) is kept.
      clearEnv: true,
      env: withoutGitVariables(),
    }).output();
    if (!out.success) {
      throw new Error(new TextDecoder().decode(out.stderr).trim());
    }
    return new TextDecoder().decode(out.stdout).trim();
  };
  try {
    const head = await git("rev-parse", "HEAD");
    // The pushed head as the remote has it now, not as last fetched.
    if (rev === "upstream") await git("fetch", "-q");
    const want = rev === "upstream" ? await git("rev-parse", "@{u}") : rev;
    if (head !== want) {
      return `the checkout ${dir} is at ${head}, not ${
        rev === "upstream" ? `its pushed head ${want}` : `the pinned ${want}`
      }`;
    }
    const dirty = await git(
      "status",
      "--porcelain",
      "--untracked-files=no",
      "--",
      ".",
      ...ignored.map((path) => `:!${path}`),
    );
    if (dirty !== "") {
      return `the checkout ${dir} has uncommitted changes:\n${dirty}`;
    }
    return undefined;
  } catch (error) {
    return `cannot read the checkout ${dir}: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }
}

/** Why the pins' snapshot entry may not stay, or undefined when it may:
 * well formed, of this page's format, built from these pins, and of the
 * Python set the live index offers. `live` is the page's own answer
 * (livePythonSet): undefined -- the index could not be had in time and
 * parsed --
 * keeps the pin, as the page then restores it too; an index without a
 * complete set does not. */
export async function snapshotPinProblem(
  pins: Pins,
  live: () => Promise<string | null | undefined>,
): Promise<string | undefined> {
  try {
    const pin = pinnedSnapshot(pins);
    const set = await live();
    if (set === undefined) {
      say("the live package index could not be read; the pin is kept");
    }
    checkPythonSet(pin.builtFrom, set);
    return undefined;
  } catch (error) {
    // Only the verdict "not this train's" is an answer; a crash is not,
    // and must not drop a pin (scripts/lib/snapshot-pin.sh).
    if (error instanceof SnapshotMismatch) return error.message;
    throw error;
  }
}

/** `--check-pin`'s exit for a refused pin, and the stderr line that
 * carries the reason: anything else -- exit 1, a crash -- is a failure to
 * check, which must not drop a pin. */
export const PIN_REFUSED_EXIT = 3;
export const PIN_REFUSED_MARKER = "snapshot pin refused: ";

/** The page's answer for the set an install under `pins` would get now. */
const liveSetOf = (pins: Pins) => () =>
  livePythonSet(pythonInstallRequest(pins));

/** Why a capture cannot start on the live index's answer: one it cannot
 * read (which set would this be?) or one without a complete set (none to
 * install). Before the capture, not after its minutes of install. */
export function captureSetProblem(
  live: string | null | undefined,
): string | undefined {
  if (live === undefined) {
    return "cannot read the live package index (20 s): which Python set is this?";
  }
  if (live === NO_COMPLETE_SET) {
    return "the live package index offers no complete Python set to capture";
  }
  return undefined;
}

/** `--check-pin`: whether the snapshot entry of the pins at `path` may
 * stay; release-playground.sh asks before carrying it into a train. */
export async function checkPin(
  path = pinsPath,
  live: (pins: Pins) => () => Promise<string | null | undefined> = liveSetOf,
): Promise<{ ok: true } | { ok: false; problem: string }> {
  const pins = await loadPins(path);
  const problem = await snapshotPinProblem(pins, live(pins));
  return problem === undefined ? { ok: true } : { ok: false, problem };
}

/** Step 1: the page captures the snapshot; the file it downloads. */
async function capture(): Promise<void> {
  // Here, not at the top: the tests import this module's checks.
  const { chromium } = await import("playwright");
  say("bundling the page");
  await ensureBundle();
  // The page reads the pins without their snapshot entry: the one being
  // replaced may be of an older shape, and a capture does not need it.
  const pins = JSON.parse(await Deno.readTextFile(pinsPath));
  delete pins.snapshot;
  const server = Deno.serve(
    { port: 0, hostname: "127.0.0.1", onListen: () => {} },
    (request) =>
      new URL(request.url).pathname === "/pins.json"
        ? Response.json(pins, { headers: ISOLATION_HEADERS })
        : handlePlaygroundRequest(request),
  );
  const url = `http://127.0.0.1:${server.addr.port}/?start&snapshot=capture`;
  const browser = await chromium.launch();
  let watch: number | undefined;
  try {
    const page = await browser.newPage({ acceptDownloads: true });
    page.on("console", (message) => {
      const text = message.text();
      if (message.type() === "error" || /snapshot|compileall/.test(text)) {
        say(`page: ${text.slice(0, 300)}`);
      }
    });
    say(`capturing at ${url}`);
    const download = page.waitForEvent("download", {
      timeout: CAPTURE_TIMEOUT_MS,
    });
    // Handled from the start: if the navigation below throws, closing the
    // browser rejects this too, and that must not hide the real error.
    download.catch(() => {});
    // The page marks the capture's outcome on <html> (src/page.ts): a
    // boot, install or capture that failed ends the boot with an error.
    // The status line is only shown, never parsed: progress names
    // packages ("libgpg-error") that would read as failures.
    const failed = page.waitForFunction(
      () => document.documentElement.dataset.snapshotCapture === "failed",
      undefined,
      { timeout: CAPTURE_TIMEOUT_MS, polling: 500 },
    ).then(async () => {
      throw new Error(
        `the capture failed: ${await page.evaluate(() =>
          document.documentElement.dataset.snapshotCaptureError
        )}`,
      );
    });
    failed.catch(() => {});
    let last = "";
    watch = setInterval(async () => {
      const status = (await page.locator("#status").textContent()
        .catch(() => "")) ?? "";
      if (status !== last) say(`status: ${(last = status).slice(0, 160)}`);
    }, 1000);
    await page.goto(url);
    const file = await Promise.race([download, failed]);
    await Deno.mkdir(dirname(snapshotPath), { recursive: true });
    await file.saveAs(`${snapshotPath}.tmp`);
    await Deno.rename(`${snapshotPath}.tmp`, snapshotPath);
  } finally {
    clearInterval(watch);
    await browser.close();
    await server.shutdown();
  }
}

type PartInfo = { name: string; sha256: string; size: number };

/** What keeps an existing release from being the one for these parts:
 * every part must be there with this sha256 (GitHub's own digest of the
 * upload) and size. Empty when it holds them. */
export function releaseProblems(
  assets: { name: string; size: number; digest: string | null }[],
  parts: PartInfo[],
): string[] {
  const byName = new Map(assets.map((asset) => [asset.name, asset]));
  return parts.flatMap((part) => {
    const asset = byName.get(part.name);
    if (asset === undefined) return [`${part.name} is missing`];
    const sha256 = asset.digest?.replace(/^sha256:/, "") ?? "(none)";
    return [
      ...(sha256 === part.sha256
        ? []
        : [`${part.name} has sha256 ${sha256}, not ${part.sha256}`]),
      ...(asset.size === part.size
        ? []
        : [`${part.name} is ${asset.size} bytes, not ${part.size}`]),
    ];
  });
}

/** Step 3: the parts as the site and the release publish them. */
async function split(file: Uint8Array, dir: string) {
  const manifest = imagePartsManifest(ASSET, file.byteLength);
  const parts: PartInfo[] = [];
  for (const [index, name] of manifest.parts.entries()) {
    const [start, end] = imagePartRange(index, file.byteLength)!;
    const bytes = file.subarray(start, end);
    await Deno.writeFile(join(dir, name), bytes);
    parts.push({
      name,
      sha256: await sha256Hex(bytes),
      size: bytes.byteLength,
    });
  }
  const sha256 = await sha256Hex(file);
  await Deno.writeTextFile(
    join(dir, `${ASSET}.sha256`),
    `${sha256}  ${ASSET}\n`,
  );
  return {
    sha256,
    parts,
    files: manifest.parts.map((name) => join(dir, name)),
  };
}

function releaseNotes(train: string, pin: SnapshotPin): string {
  const built = pin.builtFrom;
  return [
    `The sealed sandbox \`?snapshot=1\` restores for ${train}: the in-tab`,
    "Yurt kernel's memory after the slim image booted and the Python set was",
    "installed and precompiled, with no process left in it. A restore needs",
    "exactly this kernel, image and Python set:",
    "",
    `- kernel wasm sha256 \`${built.kernelSha256}\``,
    `- image sha256 \`${built.imageSha256}\``,
    `- Python set (python-seal) sha256 \`${built.pythonSealSha256}\``,
    "",
    `\`${ASSET}\` is published in ${pin.parts.length} parts (\`${ASSET}.0\`...),`,
    `${pin.size} bytes in all, sha256 \`${pin.sha256}\` (\`${ASSET}.sha256\`).`,
    "",
    "Captured locally by `scripts/release-snapshot.ts`: the page served by the",
    "dev server, `/?start&snapshot=capture` in headless Chromium, from a",
    "checkout whose artifacts/pins.json names this train.",
  ].join("\n");
}

async function main(): Promise<void> {
  const args = [...Deno.args];
  const flag = (name: string) => {
    const at = args.indexOf(name);
    if (at >= 0) args.splice(at, 1);
    return at >= 0;
  };
  if (flag("--check-pin")) {
    let path = pinsPath;
    const pinsAt = args.indexOf("--pins");
    if (pinsAt >= 0) {
      path = args[pinsAt + 1] ?? die("--pins needs a path");
      args.splice(pinsAt, 2);
    }
    if (args.length > 0) die(`unknown arguments: ${args.join(" ")}`);
    const verdict = await checkPin(path);
    if (!verdict.ok) {
      // The verdict "not this train's", apart from any other failure
      // (exit 1): only this one drops the pin (scripts/lib/snapshot-pin.sh).
      console.error(`${PIN_REFUSED_MARKER}${verdict.problem}`);
      Deno.exit(PIN_REFUSED_EXIT);
    }
    return say("the pinned snapshot is this train's");
  }
  const dryRun = flag("--dry-run");
  const resume = flag("--resume");
  let tagArg: string | undefined;
  const tagAt = args.indexOf("--tag");
  if (tagAt >= 0) {
    tagArg = args[tagAt + 1] ?? die("--tag needs a tag");
    args.splice(tagAt, 2);
  }
  if (args.length > 0) die(`unknown arguments: ${args.join(" ")}`);
  const raw = JSON.parse(await Deno.readTextFile(pinsPath));
  // The snapshot entry is what this script replaces: an older one (of
  // another train, or an older shape) is not read.
  const pins = parsePins({ ...raw, snapshot: undefined });
  const train: string = raw.train ?? die("artifacts/pins.json names no train");
  const tag = tagArg ?? `snapshot-${train}`;
  for (const blob of ["yurt_kernel.wasm", "playground-slim.yurtimg"]) {
    await Deno.stat(join(root, "artifacts", blob)).catch(() =>
      die(
        `artifacts/${blob} is missing: run scripts/install-pinned-artifacts.sh`,
      )
    );
  }

  // The page is bundled from these two checkouts: the snapshot is theirs.
  const kernelProblem = await checkoutProblem(
    kernelRoot(),
    pins.kernelWasm.rev,
    // The page's bundle writes the kernel checkout's lockfile.
    ["deno.lock"],
  );
  if (kernelProblem !== undefined) die(kernelProblem);
  // This script writes the pins.
  const pageProblem = await checkoutProblem(root, "upstream", [
    "artifacts/pins.json",
  ]);
  if (pageProblem !== undefined) die(pageProblem);

  // A capture of this train and of the set the live index offers now,
  // that decodes in full: reused with --resume; anything else (another
  // train or set, a damaged file) is captured again.
  const live = await liveSetOf(pins)();
  const setProblem = captureSetProblem(live);
  if (setProblem !== undefined) die(setProblem);
  const thisTrains = () =>
    checkSnapshotFile(
      snapshotPath,
      { ...snapshotIdentity(pins), pythonSet: live },
      { decode: true },
    );
  let check = resume ? await thisTrains() : undefined;
  if (check?.ok) {
    say(`--resume: reusing ${snapshotPath}`);
  } else {
    if (check !== undefined) say(`--resume: capturing again: ${check.problem}`);
    await capture();
    // Step 2.
    check = await thisTrains();
  }
  if (!check.ok) {
    return die(`the capture is not this train's: ${check.problem}`);
  }
  const builtFrom = check.builtFrom;
  say("the capture decodes in full");
  const file = await Deno.readFile(snapshotPath);
  const dir = await Deno.makeTempDir({ prefix: "yurt-snapshot-" });
  try {
    const { sha256, parts, files } = await split(file, dir);
    const pin: SnapshotPin = {
      releaseRepo: REPO,
      release: tag,
      format: FORMAT,
      sha256,
      size: file.byteLength,
      parts: parts.map((part) => part.sha256),
      builtFrom,
    };
    say(`${ASSET}: ${pin.size} bytes, ${parts.length} parts, sha256 ${sha256}`);

    // Step 4.
    const existing = await gh(
      ["release", "view", tag, "--repo", REPO, "--json", "assets"],
      { allowFailure: true },
    );
    if (existing.ok) {
      const published = (await gh([
        "release",
        "download",
        tag,
        "--repo",
        REPO,
        "--pattern",
        `${ASSET}.sha256`,
        "--output",
        "-",
      ])).stdout.split(/\s+/)[0];
      const problems = [
        ...(published === sha256
          ? []
          : [`${ASSET}.sha256 says ${published}, not ${sha256}`]),
        ...releaseProblems(JSON.parse(existing.stdout).assets, parts),
      ];
      if (problems.length > 0) {
        die(
          `${REPO} ${tag} already exists and does not hold this snapshot: ` +
            `${problems.join("; ")}. Rerun with --resume and the file it was ` +
            "made from, or give a new --tag.",
        );
      }
      say(
        `${tag} already holds every part of this snapshot; nothing to upload`,
      );
    } else if (dryRun) {
      say(`--dry-run: would create the prerelease ${REPO} ${tag}`);
    } else {
      const notes = join(dir, "notes.md");
      await Deno.writeTextFile(notes, releaseNotes(train, pin));
      await gh([
        "release",
        "create",
        tag,
        "--repo",
        REPO,
        "--prerelease",
        "--latest=false",
        "--title",
        `Sandbox snapshot for ${train}`,
        "--notes-file",
        notes,
        ...files,
        join(dir, `${ASSET}.sha256`),
      ]);
      say(`released ${REPO} ${tag}`);
    }

    // Step 5.
    if (dryRun) {
      say(`--dry-run: would pin\n${JSON.stringify(pin, null, 2)}`);
      return;
    }
    raw.snapshot = pin;
    await Deno.writeTextFile(pinsPath, `${JSON.stringify(raw, null, 2)}\n`);
    say("pinned in artifacts/pins.json; commit it");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

if (import.meta.main) await main();
