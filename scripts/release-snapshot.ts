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
 *   2. check the file's header names the pins' kernel, image and Python set;
 *   3. split it into the site's parts and hash them;
 *   4. create the prerelease `snapshot-<train>` on YurtOS/yurt-playground
 *      (never "latest") with the parts and a .sha256, or find it already
 *      there with the same file (a no-op);
 *   5. write the `snapshot` entry into artifacts/pins.json.
 *
 * Usage: deno run -A scripts/release-snapshot.ts [--dry-run] [--resume]
 *
 *   --dry-run  everything but the release and the pins write
 *   --resume   reuse public/snapshot/sandbox.seal.gz when it is a capture
 *              of this train (a capture is never the same bytes twice, so a
 *              release cut by an earlier run matches only its own file)
 *
 * Needs: the pinned blobs (scripts/install-pinned-artifacts.sh), the sibling
 * yurtos-kernel at the pinned rev (the page bundle), Playwright's Chromium
 * (`deno run -A npm:playwright@1.55.0 install chromium`), network access
 * (the page installs Python from YurtOS/yurt-packages), and `gh` with write
 * access to YurtOS/yurt-playground releases.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { ensureBundle } from "./serve.ts";
import { handlePlaygroundRequest } from "../src/serve.ts";
import { imagePartRange, imagePartsManifest } from "../src/image_parts.ts";
import { sha256Hex } from "../src/integrity.ts";
import { loadPins, type SnapshotPin } from "../src/pins.ts";
import {
  checkSandboxSnapshot,
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

/** Whether the file at `path` is a capture of this train. */
async function isThisTrains(
  path: string,
  pins: Awaited<ReturnType<typeof loadPins>>,
) {
  try {
    const file = await Deno.open(path);
    await checkSandboxSnapshot(file.readable, snapshotIdentity(pins));
    return true;
  } catch (error) {
    if (error instanceof SnapshotMismatch) {
      say(error.message);
      return false;
    }
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

/** Step 1: the page captures the snapshot; the file it downloads. */
async function capture(): Promise<void> {
  say("bundling the page");
  await ensureBundle();
  const server = Deno.serve(
    { port: 0, hostname: "127.0.0.1", onListen: () => {} },
    handlePlaygroundRequest,
  );
  const url = `http://127.0.0.1:${server.addr.port}/?start&snapshot=capture`;
  const browser = await chromium.launch();
  let watch: number | undefined;
  try {
    const page = await browser.newPage({ acceptDownloads: true });
    page.on("console", (message) => {
      const text = message.text();
      if (/snapshot|compileall/.test(text)) say(`page: ${text.slice(0, 300)}`);
    });
    say(`capturing at ${url}`);
    const download = page.waitForEvent("download", {
      timeout: CAPTURE_TIMEOUT_MS,
    });
    // A failed boot, install or capture is said in the status line; the
    // download then never comes.
    const failed = new Promise<never>((_, reject) => {
      let last = "";
      watch = setInterval(async () => {
        const status = (await page.locator("#status").textContent()
          .catch(() => "")) ?? "";
        if (status !== last) say(`status: ${(last = status).slice(0, 160)}`);
        if (/failed|error|did not/i.test(status)) {
          reject(new Error(`the capture failed: ${status}`));
        }
      }, 1000);
    });
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

/** Step 3: the parts as the site and the release publish them. */
async function split(file: Uint8Array, dir: string) {
  const manifest = imagePartsManifest(ASSET, file.byteLength);
  const parts: string[] = [];
  for (const [index, name] of manifest.parts.entries()) {
    const [start, end] = imagePartRange(index, file.byteLength)!;
    const bytes = file.subarray(start, end);
    await Deno.writeFile(join(dir, name), bytes);
    parts.push(await sha256Hex(bytes));
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
  const dryRun = Deno.args.includes("--dry-run");
  const resume = Deno.args.includes("--resume");
  const unknown = Deno.args.filter((a) =>
    a !== "--dry-run" && a !== "--resume"
  );
  if (unknown.length > 0) die(`unknown arguments: ${unknown.join(" ")}`);
  const raw = JSON.parse(await Deno.readTextFile(pinsPath));
  const pins = await loadPins(pinsPath);
  const train: string = raw.train ?? die("artifacts/pins.json names no train");
  const tag = `snapshot-${train}`;
  for (const blob of ["yurt_kernel.wasm", "playground-slim.yurtimg"]) {
    await Deno.stat(join(root, "artifacts", blob)).catch(() =>
      die(
        `artifacts/${blob} is missing: run scripts/install-pinned-artifacts.sh`,
      )
    );
  }

  if (resume && await isThisTrains(snapshotPath, pins)) {
    say(`--resume: reusing ${snapshotPath}`);
  } else {
    await capture();
  }
  // Step 2.
  if (!await isThisTrains(snapshotPath, pins)) {
    die("the captured snapshot was not built from artifacts/pins.json");
  }
  const file = await Deno.readFile(snapshotPath);
  const dir = await Deno.makeTempDir({ prefix: "yurt-snapshot-" });
  try {
    const { sha256, parts, files } = await split(file, dir);
    const pin: SnapshotPin = {
      releaseRepo: REPO,
      release: tag,
      sha256,
      size: file.byteLength,
      parts,
      builtFrom: snapshotIdentity(pins),
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
      if (published !== sha256) {
        die(
          `${REPO} ${tag} already holds another snapshot (sha256 ${published}). ` +
            "Rerun with --resume and the file it was made from, or delete the release.",
        );
      }
      say(`${tag} already holds this snapshot; nothing to upload`);
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
