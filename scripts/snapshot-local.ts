#!/usr/bin/env -S deno run --allow-all
/**
 * snapshot-local.ts -- capture a sandbox snapshot locally, upload it, and
 * print the URL that restores it on the live site (`?snapshot=<id>`,
 * src/snapshot_source.ts): no pin, no PR, no site deploy.
 *
 * The capture is scripts/release-snapshot.ts's own (`?snapshot=capture` in
 * headless Chromium against the dev server), and so are its checks: the
 * kernel checkout at the pinned rev, the live index's Python set, a file
 * that decodes in full and was built from the pins. Then:
 *
 *   1. split the file into the site's 20 MiB parts and write `manifest.json`
 *      (the pin's shape: format, sha256, size, each part's sha256,
 *      builtFrom; plus `name` and `packages`);
 *   2. commit them, with no parent, and push the commit to
 *      `refs/snapshots/<name>` in YurtOS/yurt-playground (not a branch: a
 *      clone does not fetch it);
 *   3. read the manifest back from raw.githubusercontent.com at that
 *      commit, as the page will;
 *   4. print `<site>/?snapshot=<commit sha>`.
 *
 * Usage: deno run -A scripts/snapshot-local.ts [--packages a,b] [--phone]
 *          [--name NAME] [--file PATH] [--dry-run] [--site URL]
 *
 *   --packages  packages to install after the Python set, before the seal
 *               (`?snapshot=capture&packages=`); the restore's checks are
 *               the Python set's alone, so these ride in its memory
 *   --phone     the phone's Python-only capture (`?snapshot=capture-phone`)
 *               and a URL with `&start-anyway`; PENDING: needs the phone
 *               snapshot work on main, and says so until then
 *   --name      the ref's name (default <train>-<UTC time>); an existing
 *               one is never replaced
 *   --file      upload this capture instead of capturing (it is checked
 *               the same way)
 *   --dry-run   everything but the push
 *   --site      the site the URL is for (default the live site)
 *
 * List: `git ls-remote origin 'refs/snapshots/*'`. Delete:
 * `git push origin :refs/snapshots/<name>` (the page then refuses its URL:
 * it restores only a commit a snapshot ref points at).
 *
 * Needs what release-snapshot.ts needs to capture (the pinned blobs, the
 * sibling yurtos-kernel at the pinned rev, Playwright's Chromium, network
 * access) and push access to YurtOS/yurt-playground through this
 * checkout's `origin`.
 */
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { kernelRoot } from "./serve.ts";
import { checkSnapshotFile } from "./lib/snapshot_file.ts";
import {
  capture,
  captureSetProblem,
  checkoutProblem,
  liveSetOf,
  split,
  withoutGitVariables,
} from "./release-snapshot.ts";
import { imagePartsManifest } from "../src/image_parts.ts";
import { parsePins, type Pins, type SnapshotPin } from "../src/pins.ts";
import {
  FORMAT,
  type SnapshotIdentity,
  snapshotIdentity,
} from "../src/sandbox_snapshot.ts";
import {
  capturePackages,
  SNAPSHOT_FILE,
  SNAPSHOT_MANIFEST,
  SNAPSHOT_REF_PREFIX,
  SNAPSHOT_REPO,
  snapshotRef,
  uploadedSnapshotBase,
} from "../src/snapshot_source.ts";

export const DEFAULT_SITE = "https://yurt-playground.pages.dev";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pinsPath = join(root, "artifacts/pins.json");

const say = (text: string) => console.error(`snapshot-local: ${text}`);
/** A refusal: thrown, so the temporary directory (a capture, its parts
 * and their git objects, ~400 MB) is removed on the way out; `Deno.exit`
 * would skip the `finally` that removes it. */
class Refused extends Error {}
const die = (text: string): never => {
  throw new Refused(text);
};

/** A ref name a snapshot may take: one path segment. */
export function snapshotNameProblem(name: string): string | undefined {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) && !name.includes("..") &&
      !name.endsWith(".lock") && !name.endsWith(".")
    ? undefined
    : `--name ${JSON.stringify(name)}: letters, digits, '.', '_' and '-' only`;
}

/** The default name: the train and the UTC time, to the second. */
export function defaultSnapshotName(train: string, now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\..*$/, "");
  return `${train}-${stamp}`;
}

/** The page query a capture runs (release-snapshot.ts `capture`). */
export function captureQuery(packages: string[], phone: boolean): string {
  return [
    "start",
    `snapshot=${phone ? "capture-phone" : "capture"}`,
    ...(packages.length > 0 ? [`packages=${packages.join(",")}`] : []),
  ].join("&");
}

/** The URL that restores snapshot `id` on `site`. */
export function restoreUrl(site: string, id: string, phone: boolean): string {
  uploadedSnapshotBase(id); // only an id
  const url = new URL(site);
  url.search = `?snapshot=${id}${phone ? "&start-anyway" : ""}`;
  return url.href;
}

/** Whether `url` (a git remote) is YurtOS/yurt-playground on GitHub. */
export function isSnapshotRemote(url: string): boolean {
  return /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)YurtOS\/yurt-playground(?:\.git)?\/?$/
    .test(url);
}

async function git(
  dir: string,
  args: string[],
  { allowFailure = false } = {},
): Promise<{ ok: boolean; code: number; stdout: string }> {
  const out = await new Deno.Command("git", {
    // The snapshot's own repository runs no hook of the caller's and
    // signs nothing: a global pre-commit hook over 130 MB, or a signing
    // key's prompt, is not this script's to run.
    args: [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "commit.gpgsign=false",
      "-C",
      dir,
      ...args,
    ],
    stdout: "piped",
    stderr: "piped",
    clearEnv: true,
    env: withoutGitVariables(),
  }).output();
  if (!out.success && !allowFailure) {
    die(
      `git ${args.join(" ")} failed: ${
        new TextDecoder().decode(out.stderr).trim()
      }`,
    );
  }
  return {
    ok: out.success,
    code: out.code,
    stdout: new TextDecoder().decode(out.stdout).trim(),
  };
}

/** The manifest, read back from where the page reads it, and the ref
 * listed where the page looks for it (src/snapshot_source.ts
 * `snapshotRef`). raw serves a new commit within seconds; the API's list
 * may be a minute old (`s-maxage=60`), so both are asked for two minutes. */
async function readBack(id: string, want: string): Promise<void> {
  const url = `${uploadedSnapshotBase(id)}${SNAPSHOT_MANIFEST}`;
  let last = "";
  for (let attempt = 0; attempt < 24; attempt++) {
    const response = await fetch(url, {
      headers: { origin: DEFAULT_SITE },
    }).catch((error) => error as Error);
    if (response instanceof Response) {
      const text = await response.text();
      if (response.ok && text === want) {
        const cors = response.headers.get("access-control-allow-origin");
        if (cors !== "*") die(`${url} answers without CORS (${cors})`);
        try {
          await snapshotRef(id);
          return;
        } catch (error) {
          last = `the snapshot refs list: ${(error as Error).message}`;
        }
      } else {
        last = `${url}: ${response.status}${
          response.ok ? " (other bytes)" : ""
        }`;
      }
    } else last = `${url}: ${response.message}`;
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  die(`the upload is not readable as the page reads it: ${last}`);
}

/** Why a snapshot made under `pins` would not be restored by `site`'s
 * deployed pins (its `/pins.json`), or undefined when it would. Only the
 * pins are compared: the page's own constants in the identity
 * (`SEAL_VERSION`, `BOOT_SETUP`, and the header `FORMAT`) are this
 * checkout's on both sides, so a capture from page code that changed one
 * of them (which the script only notes) is not caught here; the site then
 * boots the image, with a console note. */
export async function siteIdentityProblem(
  site: string,
  pins: Pins,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<string | undefined> {
  const url = new URL("/pins.json", site).href;
  let deployed: Pins;
  try {
    const response = await fetchImpl(url);
    if (!response.ok) return `cannot read ${url}: ${response.status}`;
    deployed = parsePins({ ...await response.json(), snapshot: undefined });
  } catch (error) {
    return `cannot read ${url}: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }
  const want = snapshotIdentity(deployed);
  const have = snapshotIdentity(pins);
  const differs = (Object.keys(want) as (keyof typeof want)[])
    .filter((key) => want[key] !== have[key])
    .map((key) => `${key} ${have[key]}, not ${want[key]}`);
  return differs.length === 0 ? undefined : `${site} runs another build: ` +
    `this checkout's pins give ${differs.join("; ")}`;
}

async function main(): Promise<void> {
  const args = [...Deno.args];
  const flag = (name: string) => {
    const at = args.indexOf(name);
    if (at >= 0) args.splice(at, 1);
    return at >= 0;
  };
  const option = (name: string) => {
    const at = args.indexOf(name);
    if (at < 0) return undefined;
    const value = args[at + 1] ?? die(`${name} needs a value`);
    args.splice(at, 2);
    return value;
  };
  const phone = flag("--phone");
  const dryRun = flag("--dry-run");
  let packages: string[] = [];
  try {
    packages = capturePackages(option("--packages") ?? null);
  } catch (error) {
    die((error as Error).message);
  }
  const nameArg = option("--name");
  const fileArg = option("--file");
  const site = option("--site") ?? DEFAULT_SITE;
  if (args.length > 0) die(`unknown arguments: ${args.join(" ")}`);
  if (fileArg !== undefined && packages.length > 0) {
    die("--packages is for a capture; --file uploads one as it is");
  }

  const raw = JSON.parse(await Deno.readTextFile(pinsPath));
  const pins = parsePins({ ...raw, snapshot: undefined });
  const train: string = raw.train ?? die("artifacts/pins.json names no train");
  const name = nameArg ?? defaultSnapshotName(train);
  const nameProblem = snapshotNameProblem(name);
  if (nameProblem !== undefined) die(nameProblem);
  const ref = `${SNAPSHOT_REF_PREFIX}${name}`;

  if (phone) {
    // The phone capture is the phone-snapshot work's (`capture-phone`, a
    // Python-only set, and a restore gate that lets phones restore).
    const page = await Deno.readTextFile(join(root, "src/page.ts"));
    if (!page.includes('"capture-phone"')) {
      die(
        "--phone needs the phone snapshot capture (?snapshot=capture-phone), " +
          "which is not on this checkout's page yet",
      );
    }
  }

  // Where a push goes (a pushurl, when one is set).
  const remote =
    (await git(root, ["remote", "get-url", "--push", "origin"])).stdout;
  if (!isSnapshotRemote(remote)) {
    die(`origin is ${remote}, not ${SNAPSHOT_REPO} on GitHub`);
  }
  const taken = await git(root, ["ls-remote", "--exit-code", remote, ref], {
    allowFailure: true,
  });
  // --exit-code: 2 is "no such ref"; anything else but 0 is a failure to
  // ask (network, credentials), not a free name.
  if (taken.ok) die(`${ref} already exists; give another --name`);
  if (taken.code !== 2) {
    die(`cannot ask ${remote} for ${ref}: git exited ${taken.code}`);
  }

  // The live site restores only a snapshot of its own build: a checkout
  // behind or ahead of what is deployed would print a URL that always
  // falls back.
  const siteProblem = await siteIdentityProblem(site, pins);
  if (siteProblem !== undefined) die(siteProblem);

  const live = await liveSetOf(pins)();
  const setProblem = captureSetProblem(live);
  if (setProblem !== undefined) die(setProblem);
  // The phone's set is not the site's; its own check comes with it.
  const expected: SnapshotIdentity | { pythonSet: string | null } = phone
    ? snapshotIdentity(pins)
    : { ...snapshotIdentity(pins), pythonSet: live! };

  const work = await Deno.makeTempDir({ prefix: "yurt-snapshot-local-" });
  // Ctrl-C removes it too.
  const interrupted = () => {
    Deno.removeSync(work, { recursive: true });
    Deno.exit(130);
  };
  Deno.addSignalListener("SIGINT", interrupted);
  try {
    let file = fileArg;
    if (file === undefined) {
      for (const blob of ["yurt_kernel.wasm", "playground-slim.yurtimg"]) {
        await Deno.stat(join(root, "artifacts", blob)).catch(() =>
          die(
            `artifacts/${blob} is missing: run scripts/install-pinned-artifacts.sh`,
          )
        );
      }
      const kernelProblem = await checkoutProblem(
        kernelRoot(),
        pins.kernelWasm.rev,
        ["deno.lock"],
      );
      if (kernelProblem !== undefined) die(kernelProblem);
      // The live site runs main: a capture from other page code is
      // allowed (that is how a capture change is tried), but said.
      const pageProblem = await checkoutProblem(root, "upstream");
      if (pageProblem !== undefined) say(`note: ${pageProblem}`);
      file = join(work, "capture", SNAPSHOT_FILE);
      await capture({ query: captureQuery(packages, phone), out: file });
    }
    const check = await checkSnapshotFile(
      file,
      expected as SnapshotIdentity,
      { decode: true },
    );
    if (!check.ok) {
      return die(`the capture is not this site's: ${check.problem}`);
    }
    say("the capture decodes in full");

    const bytes = await Deno.readFile(file);
    const tree = join(work, "tree");
    await Deno.mkdir(tree);
    const { sha256, parts } = await split(bytes, tree);
    await Deno.writeTextFile(
      join(tree, `${SNAPSHOT_FILE}.parts.json`),
      `${
        JSON.stringify(imagePartsManifest(SNAPSHOT_FILE, bytes.byteLength))
      }\n`,
    );
    const pin: SnapshotPin = {
      releaseRepo: SNAPSHOT_REPO,
      release: ref,
      format: FORMAT,
      sha256,
      size: bytes.byteLength,
      parts: parts.map((part) => part.sha256),
      builtFrom: check.builtFrom,
    };
    const manifest = `${
      JSON.stringify({ ...pin, name, train, packages, phone }, null, 2)
    }\n`;
    await Deno.writeTextFile(join(tree, SNAPSHOT_MANIFEST), manifest);
    say(`${SNAPSHOT_FILE}: ${pin.size} bytes, ${parts.length} parts`);

    await git(tree, ["init", "-q"]);
    await git(tree, ["add", "-A"]);
    await git(tree, [
      "commit",
      "-q",
      "-m",
      `snapshot ${name}\n\nTrain ${train}; Python set ${check.builtFrom.pythonSet}` +
      `${packages.length > 0 ? `; packages ${packages.join(", ")}` : ""}.\n` +
      "Made by scripts/snapshot-local.ts; restored by ?snapshot=<this commit>.",
    ]);
    const id = (await git(tree, ["rev-parse", "HEAD"])).stdout;
    if (dryRun) {
      say(`--dry-run: would push ${id} to ${remote} ${ref}`);
      console.log(restoreUrl(site, id, phone));
      return;
    }
    say(`pushing ${id} to ${ref}`);
    await git(tree, ["push", "-q", remote, `HEAD:${ref}`]);
    await readBack(id, manifest);
    say(`${ref} is served at ${uploadedSnapshotBase(id)}`);
    console.log(restoreUrl(site, id, phone));
  } finally {
    Deno.removeSignalListener("SIGINT", interrupted);
    await Deno.remove(work, { recursive: true });
  }
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    if (!(error instanceof Refused)) throw error;
    say(error.message);
    Deno.exit(1);
  }
}
