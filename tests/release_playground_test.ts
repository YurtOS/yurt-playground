import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

/** This process's environment without git's own variables. Under a git
 * hook (the pre-commit fast suite runs this file) git exports GIT_DIR,
 * GIT_INDEX_FILE and friends, and a child `git -C <fixture>` would then
 * act on the repository being committed instead of the fixture: set its
 * user.name to "Test", add remotes, tag it. */
function fixtureEnv(
  extra: Record<string, string> = {},
): Record<string, string> {
  const env = Object.fromEntries(
    Object.entries(Deno.env.toObject()).filter(([key]) =>
      !key.startsWith("GIT_")
    ),
  );
  return { ...env, ...extra };
}

async function command(
  executable: string,
  args: string[],
  options: Deno.CommandOptions = {},
): Promise<Deno.CommandOutput> {
  const result = await new Deno.Command(executable, {
    args,
    stdout: "piped",
    stderr: "piped",
    ...options,
    clearEnv: true,
    env: fixtureEnv(options.env),
  }).output();
  return result;
}

/** The release script's sourced helpers (scripts/lib/), into a fixture
 * project at `root`. */
async function copyScriptLib(root: string): Promise<void> {
  await Deno.mkdir(join(root, "scripts/lib"), { recursive: true });
  for await (const entry of Deno.readDir(join(repoRoot, "scripts/lib"))) {
    await Deno.copyFile(
      join(repoRoot, "scripts/lib", entry.name),
      join(root, "scripts/lib", entry.name),
    );
  }
}

async function git(dir: string, ...args: string[]): Promise<string> {
  const result = await command("git", ["-C", dir, ...args]);
  assertEquals(result.code, 0, new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout).trim();
}

Deno.test("--pins-only does not require a kernel release tag", async () => {
  const dir = await Deno.makeTempDir({ prefix: "release-playground-" });
  try {
    const kernel = join(dir, "kernel");
    await Deno.mkdir(kernel);
    await command("git", ["init", "-q", kernel]);
    await git(
      kernel,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "--allow-empty",
      "-qm",
      "fixture",
    );
    const sha = await git(kernel, "rev-parse", "HEAD");
    await git(kernel, "remote", "add", "origin", kernel);

    const bin = join(dir, "bin");
    await Deno.mkdir(bin);
    const gh = join(bin, "gh");
    await Deno.writeTextFile(gh, "#!/bin/sh\nexit 0\n");
    await Deno.chmod(gh, 0o755);

    const releaseScript = await Deno.readTextFile(
      join(repoRoot, "scripts/release-playground.sh"),
    );
    const startup = releaseScript.split("# ---- the train label")[0];
    const harnessRoot = join(dir, "project");
    await Deno.mkdir(join(harnessRoot, "scripts/lib"), { recursive: true });
    await copyScriptLib(harnessRoot);
    const harness = join(harnessRoot, "scripts/release-playground.sh");
    await Deno.writeTextFile(
      harness,
      `${startup}\nprintf 'REACHED_TRAIN_SETUP\\n'\n`,
    );

    const result = await command(
      "bash",
      [
        harness,
        "--pins-only",
        "--kernel-sha",
        sha,
        "--ports-sha",
        sha,
        "--sandbox-sha",
        sha,
        "--kernel-wasm-release",
        "kernel-wasm-fixture",
        "--image-release",
        "image-fixture",
        "--desktop-host-release",
        "host-fixture",
        "--yurt-cli-release",
        "cli-fixture",
      ],
      {
        env: {
          PATH: `${bin}:${Deno.env.get("PATH") ?? ""}`,
          YURT_KERNEL_ROOT: kernel,
        },
      },
    );
    const output = new TextDecoder().decode(result.stdout) +
      new TextDecoder().decode(result.stderr);
    assertEquals(result.code, 0, output);
    assertStringIncludes(output, "REACHED_TRAIN_SETUP");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("kernel release lookup verifies tags from linked worktrees", async () => {
  const dir = await Deno.makeTempDir({ prefix: "kernel-release-" });
  try {
    const remote = join(dir, "remote.git");
    const source = join(dir, "source");
    const checkout = join(dir, "checkout");
    const worktree = join(dir, "worktree");
    await command("git", ["init", "--bare", "-q", remote]);
    await command("git", ["init", "-q", source]);
    await git(source, "config", "user.name", "Test");
    await git(source, "config", "user.email", "test@example.invalid");
    await git(source, "remote", "add", "origin", remote);
    await git(source, "commit", "--allow-empty", "-qm", "tagged commit");
    const taggedSha = await git(source, "rev-parse", "HEAD");
    await git(source, "tag", "-a", "kernel-v1.0.0", "-m", "fixture");
    await git(source, "push", "-q", "origin", "HEAD", "--tags");
    await command("git", ["clone", "-q", remote, checkout]);
    await git(checkout, "worktree", "add", "--detach", worktree, "HEAD");

    const helper = join(repoRoot, "scripts/lib/kernel-release.sh");
    const resolve = (at: string, sha: string) =>
      command("bash", [
        "-c",
        'die() { echo "release-playground: $*" >&2; exit 1; }; source "$1"; resolve_kernel_release "$2" "$3"',
        "kernel-release-test",
        helper,
        at,
        sha,
      ]);

    const valid = await resolve(worktree, taggedSha);
    assertEquals(valid.code, 0, new TextDecoder().decode(valid.stderr));
    assertEquals(
      new TextDecoder().decode(valid.stdout).trim(),
      "kernel-v1.0.0",
    );

    await git(source, "commit", "--allow-empty", "-qm", "moved tag target");
    await git(source, "tag", "-f", "kernel-v1.0.0");
    await git(source, "push", "-q", "--force", "origin", "kernel-v1.0.0");
    const stale = await resolve(worktree, taggedSha);
    assertEquals(stale.code, 1);
    const staleError = new TextDecoder().decode(stale.stderr);
    assertEquals(
      staleError.includes("could not fetch") ||
        staleError.includes("no kernel-v* release tag"),
      true,
      staleError,
    );

    await git(
      worktree,
      "remote",
      "set-url",
      "origin",
      join(dir, "missing.git"),
    );
    const unavailable = await resolve(worktree, taggedSha);
    assertEquals(unavailable.code, 1);
    assertStringIncludes(
      new TextDecoder().decode(unavailable.stderr),
      "could not fetch",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("resume watches a recorded kernel run without resolving its tag", async () => {
  const dir = await Deno.makeTempDir({ prefix: "release-resume-" });
  try {
    const root = join(dir, "project");
    await Deno.mkdir(join(root, "scripts/lib"), { recursive: true });
    await copyScriptLib(root);
    await writePinnedCli(root);
    const scriptPath = join(root, "scripts/release-playground.sh");
    const source = await Deno.readTextFile(
      join(repoRoot, "scripts/release-playground.sh"),
    );
    const throughKernelStep = source.split(
      "# [2] the image and the sealable cpython, one run.",
    )[0];
    await Deno.writeTextFile(
      scriptPath,
      `${throughKernelStep}\nfi\nprintf 'REACHED_IMAGE_STEP\\n'\n`,
    );

    const train = "playground-2026.09.28-aaaaaaa";
    const sha = "a".repeat(40);
    const stateDir = join(dir, "state/yurt-playground/releases");
    await Deno.mkdir(stateDir, { recursive: true });
    await Deno.writeTextFile(
      join(stateDir, `${train}.json`),
      JSON.stringify({
        train,
        kernel_sha: sha,
        ports_sha: sha,
        sandbox_sha: sha,
        build_image: true,
        validate: 0,
        // Where [3] builds, recorded at the start (as every train since
        // that record does).
        steps: { kernel_wasm: { run_id: 123 }, native: { ref: "main" } },
      }),
    );

    const bin = join(dir, "bin");
    await Deno.mkdir(bin);
    const gh = join(bin, "gh");
    await Deno.writeTextFile(
      gh,
      "#!/bin/sh\ncase \"$1 $2\" in\n  'auth status') exit 0;;\n  'run view') echo completed/success;;\n  'run watch') exit 0;;\n  *) echo \"unexpected gh call: $*\" >&2; exit 1;;\nesac\n",
    );
    await Deno.chmod(gh, 0o755);

    const result = await command(
      "bash",
      [scriptPath, "--resume", "--train", train],
      {
        env: {
          PATH: `${bin}:${Deno.env.get("PATH") ?? ""}`,
          XDG_STATE_HOME: join(dir, "state"),
          YURT_KERNEL_ROOT: join(dir, "missing-kernel-checkout"),
        },
      },
    );
    const output = new TextDecoder().decode(result.stdout) +
      new TextDecoder().decode(result.stderr);
    assertEquals(result.code, 0, output);
    assertStringIncludes(output, "REACHED_IMAGE_STEP");
    const state = JSON.parse(
      await Deno.readTextFile(join(stateDir, `${train}.json`)),
    );
    assertEquals(state.steps.kernel_wasm.conclusion, "success");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

/** A project whose release script stops before the image step, a `gh` that
 * answers `auth status`, `run view` with `runView` and `run watch` with
 * `watchExit`, and a state directory holding `trains`, each state file last
 * written `minutesAgo` before now (the order a bare --resume goes by). */
async function resumeFixture(
  trains: { train: string; validate: 0 | 1; minutesAgo?: number }[],
  gh: { runView: string; watchExit: number },
) {
  const dir = await Deno.makeTempDir({ prefix: "release-resume-" });
  const root = join(dir, "project");
  await Deno.mkdir(join(root, "scripts/lib"), { recursive: true });
  await copyScriptLib(root);
  await writePinnedCli(root);
  const scriptPath = join(root, "scripts/release-playground.sh");
  const source = await Deno.readTextFile(
    join(repoRoot, "scripts/release-playground.sh"),
  );
  await Deno.writeTextFile(
    scriptPath,
    `${
      source.split("# [2] the image and the sealable cpython, one run.")[0]
    }\nfi\nprintf 'REACHED_IMAGE_STEP\\n'\n`,
  );
  const stateDir = join(dir, "state/yurt-playground/releases");
  await Deno.mkdir(stateDir, { recursive: true });
  const sha = "a".repeat(40);
  for (const { train, validate, minutesAgo = 0 } of trains) {
    const file = join(stateDir, `${train}.json`);
    await Deno.writeTextFile(
      file,
      JSON.stringify({
        train,
        kernel_sha: sha,
        ports_sha: sha,
        sandbox_sha: sha,
        build_image: true,
        validate,
        // Where [3] builds, recorded at the start (as every train since
        // that record does).
        steps: { kernel_wasm: { run_id: 123 }, native: { ref: "main" } },
      }),
    );
    const written = new Date(Date.now() - minutesAgo * 60_000);
    await Deno.utime(file, written, written);
  }
  const bin = join(dir, "bin");
  await Deno.mkdir(bin);
  await Deno.writeTextFile(
    join(bin, "gh"),
    `#!/bin/sh\ncase "$1 $2" in\n  'auth status') exit 0;;\n  'run view') echo ${gh.runView};;\n  'run watch') exit ${gh.watchExit};;\n  *) echo "unexpected gh call: $*" >&2; exit 1;;\nesac\n`,
  );
  await Deno.chmod(join(bin, "gh"), 0o755);
  const run = async (...args: string[]) => {
    const result = await command("bash", [scriptPath, ...args], {
      env: {
        PATH: `${bin}:${Deno.env.get("PATH") ?? ""}`,
        XDG_STATE_HOME: join(dir, "state"),
        YURT_KERNEL_ROOT: join(dir, "missing-kernel-checkout"),
      },
    });
    return {
      code: result.code,
      output: new TextDecoder().decode(result.stdout) +
        new TextDecoder().decode(result.stderr),
    };
  };
  return { run, cleanup: () => Deno.remove(dir, { recursive: true }) };
}

const today = new Date().toISOString().slice(0, 10).replaceAll("-", ".");

Deno.test("a bare --resume does not pass over a newer rehearsal to an older real train", async () => {
  // 2026-10-12: `--resume` after a failed rehearsal resumed the abandoned
  // real train playground-2026.09.29-c48d70d and dispatched its native run.
  const fixture = await resumeFixture([
    { train: "playground-2026.09.29-c48d70d", validate: 0, minutesAgo: 60 },
    { train: `playground-${today}-5ddc591-validate`, validate: 1 },
  ], { runView: "completed/success", watchExit: 0 });
  try {
    const { code, output } = await fixture.run("--resume");
    assertEquals(code, 1, output);
    assertStringIncludes(
      output,
      `--resume --train playground-${today}-5ddc591 --validate`,
    );
    assertEquals(output.includes("REACHED_IMAGE_STEP"), false, output);
  } finally {
    await fixture.cleanup();
  }
});

Deno.test("a bare --resume does not pick a train that started on another day", async () => {
  const fixture = await resumeFixture([
    { train: "playground-2026.09.29-c48d70d", validate: 0 },
  ], { runView: "completed/success", watchExit: 0 });
  try {
    const bare = await fixture.run("--resume");
    assertEquals(bare.code, 1, bare.output);
    assertStringIncludes(bare.output, "did not start today");
    assertStringIncludes(
      bare.output,
      "--resume --train playground-2026.09.29-c48d70d",
    );
    // Named, it resumes.
    const named = await fixture.run(
      "--resume",
      "--train",
      "playground-2026.09.29-c48d70d",
    );
    assertEquals(named.code, 0, named.output);
    assertStringIncludes(named.output, "REACHED_IMAGE_STEP");
  } finally {
    await fixture.cleanup();
  }
});

Deno.test("a failed rehearsal step names the command that resumes it", async () => {
  const train = `playground-${today}-5ddc591`;
  const fixture = await resumeFixture([
    { train: `${train}-validate`, validate: 1 },
  ], { runView: "in_progress/", watchExit: 1 });
  try {
    const { code, output } = await fixture.run("--resume", "--validate");
    assertEquals(code, 1, output);
    assertStringIncludes(
      output,
      `failed; fix it, then scripts/release-playground.sh --resume --train ${train} --validate`,
    );
  } finally {
    await fixture.cleanup();
  }
});

Deno.test("a bare --resume takes the real train written after its own rehearsal", async () => {
  // Labels do not order by time: X-validate sorts after X. With the
  // rehearsal left unfinished and the real train X the one last worked on,
  // --resume means X.
  const train = `playground-${today}-5ddc591`;
  const fixture = await resumeFixture([
    { train: `${train}-validate`, validate: 1, minutesAgo: 60 },
    { train, validate: 0 },
  ], { runView: "completed/success", watchExit: 0 });
  try {
    const { code, output } = await fixture.run("--resume");
    assertEquals(code, 0, output);
    assertStringIncludes(output, `train   ${train}`);
    assertStringIncludes(output, "REACHED_IMAGE_STEP");
  } finally {
    await fixture.cleanup();
  }
});

Deno.test("a bare --resume takes the train written last, not the higher kernel sha", async () => {
  // Two trains on one day tie on the date; the label then orders by sha.
  const fixture = await resumeFixture([
    { train: `playground-${today}-fffffff`, validate: 0, minutesAgo: 60 },
    { train: `playground-${today}-0000000`, validate: 0 },
  ], { runView: "completed/success", watchExit: 0 });
  try {
    const { code, output } = await fixture.run("--resume");
    assertEquals(code, 0, output);
    assertStringIncludes(output, `train   playground-${today}-0000000`);
  } finally {
    await fixture.cleanup();
  }
});

Deno.test("--resume keeps the repository of an --image-release train's image and seal", async () => {
  // #196: the state file recorded only the image's tag, so a resumed train
  // looked for it in yurt-packages and failed at the sidecar fetch, and the
  // --python-seal-release given at the start was dropped.
  const dir = await Deno.makeTempDir({ prefix: "release-resume-image-" });
  try {
    const root = join(dir, "project");
    await Deno.mkdir(join(root, "scripts/lib"), { recursive: true });
    await copyScriptLib(root);
    const scriptPath = join(root, "scripts/release-playground.sh");
    const source = await Deno.readTextFile(
      join(repoRoot, "scripts/release-playground.sh"),
    );
    // Stop once the state file is written; report what [3] and [4] would use.
    await Deno.writeTextFile(
      scriptPath,
      `${
        source.split("# ---- dispatch + watch one workflow")[0]
      }\nfi\nprintf 'IMAGE=%s@%s SEAL=%s@%s\\n' "$image_repo" "$image_release" "\${seal_repo:-}" "\${seal_release:-}"\n`,
    );
    const bin = join(dir, "bin");
    await Deno.mkdir(bin);
    await Deno.writeTextFile(
      join(bin, "gh"),
      "#!/bin/sh\ncase \"$1 $2\" in\n  'auth status'|'release view') exit 0;;\n  *) echo \"unexpected gh call: $*\" >&2; exit 1;;\nesac\n",
    );
    await Deno.chmod(join(bin, "gh"), 0o755);
    // A real train builds only commits on main: one checkout whose
    // origin/main has the commit, standing in for yurt-sandbox and
    // yurtos-kernel.
    const origin = join(dir, "origin");
    await command("git", ["init", "-q", "-b", "main", origin]);
    await git(
      origin,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.invalid",
      "commit",
      "--allow-empty",
      "-qm",
      "main",
    );
    const checkout = join(dir, "checkout");
    await command("git", ["clone", "-q", origin, checkout]);
    const sha = await git(origin, "rev-parse", "HEAD");
    const run = async (...args: string[]) => {
      const result = await command("bash", [scriptPath, ...args], {
        env: {
          PATH: `${bin}:${Deno.env.get("PATH") ?? ""}`,
          XDG_STATE_HOME: join(dir, "state"),
          YURT_KERNEL_ROOT: checkout,
          YURT_SANDBOX_ROOT: checkout,
        },
      });
      const output = new TextDecoder().decode(result.stdout) +
        new TextDecoder().decode(result.stderr);
      assertEquals(result.code, 0, output);
      return output;
    };

    const train = "playground-2026.10.12-5ddc591";
    const image = "YurtOS/yurt-ports@playground-image-x";
    const seal = "YurtOS/yurt-ports@python-seal-x";
    const started = await run(
      "--train",
      train,
      "--kernel-sha",
      sha,
      "--ports-sha",
      sha,
      "--sandbox-sha",
      sha,
      "--image-release",
      image,
      "--python-seal-release",
      seal,
    );
    assertStringIncludes(started, `IMAGE=${image} SEAL=${seal}`);

    const resumed = await run("--resume", "--train", train);
    assertStringIncludes(resumed, `IMAGE=${image} SEAL=${seal}`);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("--resume reads a merged pin PR's pins after its branch is deleted", async () => {
  const dir = await Deno.makeTempDir({ prefix: "release-merged-pin-pr-" });
  try {
    const train = "playground-2026.10.25-aaaaaaa";
    // origin: the merge commit holds the pins; the PR's branch is gone, as
    // `gh pr merge --delete-branch` leaves it.
    const origin = join(dir, "origin");
    await command("git", ["init", "-q", origin]);
    await Deno.mkdir(join(origin, "artifacts"));
    await Deno.writeTextFile(
      join(origin, "artifacts/pins.json"),
      JSON.stringify({ pythonSeal: { release: `python-seal-${train}` } }),
    );
    const author = [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=t@example.invalid",
    ];
    await git(origin, "add", "artifacts/pins.json");
    await git(origin, ...author, "commit", "-qm", `release: ${train}`);
    const mergeSha = await git(origin, "rev-parse", "HEAD");
    await git(origin, "config", "uploadpack.allowAnySHA1InWant", "true");
    const root = join(dir, "project");
    await command("git", ["clone", "-q", origin, root]);

    const source = await Deno.readTextFile(
      join(repoRoot, "scripts/release-playground.sh"),
    );
    const block = source.split("# [4] the pin PR, merged on a yes")[1]
      .split('if [ "$pr_state" != MERGED ]; then')[0];
    const scriptPath = join(dir, "block.sh");
    await Deno.writeTextFile(
      scriptPath,
      `set -euo pipefail
say() { printf '==> %s\\n' "$*" >&2; }
die() { echo "release-playground: $*" >&2; exit 1; }
root=${JSON.stringify(root)}
train=${JSON.stringify(train)}
image_rev_note=
# [4] the pin PR${block}
printf 'SEAL=%s\\n' "$seal_release_of_train"
`,
    );

    const bin = join(dir, "bin");
    await Deno.mkdir(bin);
    const pr = "https://github.com/YurtOS/yurt-playground/pull/1";
    await Deno.writeTextFile(
      join(bin, "gh"),
      `#!/bin/sh
case "$1 $2" in
  'pr list') echo '{"url":"${pr}","state":"MERGED"}';;
  'pr view') echo '${mergeSha}';;
  *) echo "unexpected gh call: $*" >&2; exit 1;;
esac
`,
    );
    await Deno.chmod(join(bin, "gh"), 0o755);

    const result = await command("bash", [scriptPath], {
      env: { PATH: `${bin}:${Deno.env.get("PATH") ?? ""}` },
    });
    const output = new TextDecoder().decode(result.stdout) +
      new TextDecoder().decode(result.stderr);
    assertEquals(result.code, 0, output);
    assertStringIncludes(output, `SEAL=python-seal-${train}`);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

/** A train resumed after its kernel step, with yurt-ports, yurtos-kernel and
 * yurt-sandbox checkouts whose origin/main has `main` and whose PR branch has
 * `pr` (each kernel commit carries a kernel-v* tag), and a `gh` that logs
 * every call to `gh.log`: dispatches succeed, releases do not exist (except
 * `imageRelease`), and yurt-ports and yurt-sandbox branches live in marker
 * directories (created by `api -X POST .../git/refs`, deleted by
 * `api -X DELETE`). */
/** The CLI the fixture's pins.json records, as [4] writes it: one asset and
 * one sha256 per platform. [2]'s smoke installs the amd64 .deb. */
const pinnedCliDebSha256 = "f".repeat(63) + "0";
const pinnedCli = {
  releaseRepo: "YurtOS/yurt-sandbox",
  release: "yurt-cli-pinned",
  assets: {
    "aarch64-apple-darwin": "yurt-aarch64-apple-darwin.tar.gz",
    "x86_64-unknown-linux-gnu": "yurt_0.1.0+pinned_amd64.deb",
    "aarch64-unknown-linux-gnu": "yurt_0.1.0+pinned_arm64.deb",
  },
  sha256: {
    "aarch64-apple-darwin": "a".repeat(64),
    "x86_64-unknown-linux-gnu": pinnedCliDebSha256,
    "aarch64-unknown-linux-gnu": "b".repeat(64),
  },
};

/** A pins.json with only the CLI, which a train reads before [1]. */
async function writePinnedCli(root: string) {
  await Deno.mkdir(join(root, "artifacts"), { recursive: true });
  await Deno.writeTextFile(
    join(root, "artifacts/pins.json"),
    JSON.stringify({ yurtCli: pinnedCli }),
  );
}

async function imageStepFixture(
  opts: {
    validate: 0 | 1;
    ports: "main" | "pr";
    kernel: "main" | "pr";
    sandbox?: "main" | "pr";
    fresh?: boolean;
    /** A hand-cut image (--image-release): [2] is skipped. */
    imageRelease?: string;
    /** A branch left in yurt-sandbox by an unfinished rehearsal. */
    staleSandboxBranch?: boolean;
    /** The [3] ref the resumed train's state file recorded. */
    nativeRef?: string;
    /** Where YURT_SANDBOX_ROOT points, under the fixture (a checkout by default). */
    sandboxRoot?: string;
    /** The kernel wasm run ([1]) fails. */
    failKernelRun?: boolean;
    /** pins.json's yurtCli entry, in place of the pinned CLI below. */
    yurtCli?: unknown;
    /** Stop where [4] starts and print the CLI it would pin. */
    stopAtPins?: boolean;
  },
) {
  const sandbox = opts.sandbox ?? "main";
  const dir = await Deno.makeTempDir({ prefix: "release-image-ref-" });
  const root = join(dir, "project");
  await Deno.mkdir(join(root, "scripts/lib"), { recursive: true });
  await Deno.mkdir(join(root, "artifacts"), { recursive: true });
  await copyScriptLib(root);
  const source = await Deno.readTextFile(
    join(repoRoot, "scripts/release-playground.sh"),
  );
  const pinsStep = "# [4] pins.json from the releases' own sidecars";
  await Deno.writeTextFile(
    join(root, "scripts/release-playground.sh"),
    opts.stopAtPins
      ? `${
        source.split(pinsStep)[0]
      }\nprintf 'PINS_CLI=%s@%s\\n' "$cli_repo" "$cli_release"\nexit 0\n`
      : source,
  );
  await Deno.writeTextFile(
    join(root, "artifacts/pins.json"),
    JSON.stringify({
      image: {
        releaseRepo: "YurtOS/yurt-ports",
        release: "playground-image-pinned",
      },
      yurtCli: opts.yurtCli ?? pinnedCli,
    }),
  );
  const shas: Record<string, { main: string; pr: string }> = {};
  for (const name of ["ports", "kernel", "sandbox"]) {
    const origin = join(dir, `${name}-origin`);
    await command("git", ["init", "-q", "-b", "main", origin]);
    const commit = (msg: string) =>
      git(
        origin,
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@example.invalid",
        "commit",
        "--allow-empty",
        "-qm",
        msg,
      );
    await commit(`${name} main`);
    const main = await git(origin, "rev-parse", "HEAD");
    await git(origin, "checkout", "-qb", "pr");
    await commit(`${name} pr`);
    const pr = await git(origin, "rev-parse", "HEAD");
    if (name === "kernel") {
      await git(origin, "tag", "kernel-v0.0.1", main);
      await git(origin, "tag", "kernel-v0.0.2-pr", pr);
    }
    await git(origin, "checkout", "-q", "main");
    await command("git", [
      "clone",
      "-q",
      "--branch",
      "main",
      origin,
      join(dir, name),
    ]);
    shas[name] = { main, pr };
  }
  const train = `playground-${today}-aaaaaaa${
    opts.validate ? "-validate" : ""
  }`;
  const stateDir = join(dir, "state/yurt-playground/releases");
  await Deno.mkdir(stateDir, { recursive: true });
  const stateFile = join(stateDir, `${train}.json`);
  if (!opts.fresh) {
    await Deno.writeTextFile(
      stateFile,
      JSON.stringify({
        train,
        kernel_sha: shas.kernel[opts.kernel],
        ports_sha: shas.ports[opts.ports],
        sandbox_sha: shas.sandbox[sandbox],
        image_release: `playground-image-${train}`,
        image_repo: "YurtOS/yurt-ports",
        build_image: true,
        validate: opts.validate,
        steps: {
          kernel_wasm: { run_id: 1, conclusion: "success" },
          image: { jupyter_payload_release: "jupyter-payload-x" },
          ...(opts.nativeRef !== undefined
            ? { native: { ref: opts.nativeRef.replace("<train>", train) } }
            : {}),
        },
      }),
    );
  }
  const bin = join(dir, "bin");
  const refs = join(dir, "refs");
  await Deno.mkdir(bin);
  await Deno.mkdir(join(refs, "yurt-ports"), { recursive: true });
  await Deno.mkdir(join(refs, "yurt-sandbox"), { recursive: true });
  if (opts.staleSandboxBranch) {
    await Deno.mkdir(join(refs, "yurt-sandbox", "validate", train), {
      recursive: true,
    });
  }
  const log = join(dir, "gh.log");
  await Deno.writeTextFile(
    join(bin, "gh"),
    `#!/bin/bash
printf '%s\\n' "$*" >> "${log}"
case "$*" in
  "auth status") exit 0;;
  "release view ${opts.imageRelease ?? "-"} "*) exit 0;;
  "release view"*) exit 1;;
  "api repos/YurtOS/yurt-ports/commits/main --jq .sha") echo ${shas.ports.main};;
  "api repos/YurtOS/yurt-sandbox/commits/main --jq .sha") echo ${shas.sandbox.main};;
  "api repos/YurtOS/yurt-packages/releases --paginate"*) echo jupyter-payload-x;;
  "api -X POST repos/YurtOS/"*"/git/refs -f ref=refs/heads/"*)
    repo=\${4#repos/YurtOS/}; repo=\${repo%%/*}
    ref=\${6#ref=refs/heads/}; mkdir -p "${refs}/\$repo/\$ref";;
  "api -X DELETE repos/YurtOS/"*"/git/refs/heads/"*)
    repo=\${4#repos/YurtOS/}; repo=\${repo%%/*}
    rm -rf "${refs}/\$repo/\${4#repos/YurtOS/*/git/refs/heads/}";;
  "api repos/YurtOS/"*"/git/refs/heads/"*)
    repo=\${2#repos/YurtOS/}; repo=\${repo%%/*}
    [ -d "${refs}/\$repo/\${2#repos/YurtOS/*/git/refs/heads/}" ];;
  "workflow run"*) ;;
  "run list"*) echo 456;;
  "run watch"*) ${opts.failKernelRun ? "exit 1" : "exit 0"};;
  *) echo "unexpected gh call: $*" >&2; exit 1;;
esac
`,
  );
  await Deno.chmod(join(bin, "gh"), 0o755);
  const args = opts.fresh
    ? [
      "--kernel-sha",
      shas.kernel[opts.kernel],
      "--ports-sha",
      shas.ports[opts.ports],
      "--sandbox-sha",
      shas.sandbox[sandbox],
      "--train",
      train.replace(/-validate$/, ""),
      ...(opts.imageRelease ? ["--image-release", opts.imageRelease] : []),
    ]
    : ["--resume", "--train", train.replace(/-validate$/, "")];
  if (opts.validate) args.push("--validate");
  const result = await command(
    "bash",
    [join(root, "scripts/release-playground.sh"), ...args],
    {
      env: {
        PATH: `${bin}:${Deno.env.get("PATH") ?? ""}`,
        XDG_STATE_HOME: join(dir, "state"),
        YURT_KERNEL_ROOT: join(dir, "kernel"),
        YURT_PORTS_ROOT: join(dir, "ports"),
        YURT_SANDBOX_ROOT: join(dir, opts.sandboxRoot ?? "sandbox"),
      },
    },
  );
  const calls = (await Deno.readTextFile(log)).split("\n").filter((l) => l);
  // Branches left behind, under refs/<repo>/validate/.
  let leftBranches = 0;
  for (const repo of ["yurt-ports", "yurt-sandbox"]) {
    try {
      leftBranches +=
        [...Deno.readDirSync(join(refs, repo, "validate"))].length;
    } catch { /* none was ever made */ }
  }
  return {
    train,
    code: result.code,
    output: new TextDecoder().decode(result.stdout) +
      new TextDecoder().decode(result.stderr),
    shas,
    dispatches: calls.filter((c) => c.startsWith("workflow run")),
    calls,
    leftBranches,
    stateLeft: await Deno.stat(stateFile).then(() => true, () => false),
    state: await Deno.readTextFile(stateFile).then(
      (t) => JSON.parse(t),
      () => undefined,
    ),
    cleanup: () => Deno.remove(dir, { recursive: true }),
  };
}

Deno.test("a rehearsal of a ports commit off main builds the image from a validate branch and publishes nothing", async () => {
  const f = await imageStepFixture({
    validate: 1,
    ports: "pr",
    kernel: "main",
  });
  try {
    assertEquals(f.code, 0, f.output);
    const [image, native] = f.dispatches;
    assertStringIncludes(image, "release-playground-image.yml");
    assertStringIncludes(image, `--ref validate/${f.train}`);
    assertStringIncludes(image, "-f publish=false");
    // The host and CLI are tested against the image the page pins today.
    assertStringIncludes(native, "release-native.yml");
    assertStringIncludes(native, "--ref main");
    assertStringIncludes(native, "-f image_release=playground-image-pinned");
    assertEquals(f.dispatches.length, 2, f.calls.join("\n"));
    // The branch was made at yurt-ports main's head and is gone at the end.
    assertStringIncludes(
      f.calls.join("\n"),
      `-f ref=refs/heads/validate/${f.train}`,
    );
    assertStringIncludes(
      f.calls.join("\n"),
      `api -X DELETE repos/YurtOS/yurt-ports/git/refs/heads/validate/${f.train}`,
    );
    assertEquals(f.leftBranches, 0, "the validate branch was not deleted");
  } finally {
    await f.cleanup();
  }
});

Deno.test("a rehearsal of a kernel commit off main builds the image from a validate branch too", async () => {
  const f = await imageStepFixture({
    validate: 1,
    ports: "main",
    kernel: "pr",
  });
  try {
    assertEquals(f.code, 0, f.output);
    assertStringIncludes(f.dispatches[0], `--ref validate/${f.train}`);
    assertStringIncludes(f.dispatches[0], "-f publish=false");
  } finally {
    await f.cleanup();
  }
});

Deno.test("a rehearsal of both mains builds the image from main and publishes its prereleases", async () => {
  const f = await imageStepFixture({
    validate: 1,
    ports: "main",
    kernel: "main",
  });
  try {
    assertEquals(f.code, 0, f.output);
    const [image, native] = f.dispatches;
    assertStringIncludes(image, "--ref main");
    assertStringIncludes(image, "-f publish=true");
    assertStringIncludes(
      native,
      `-f image_release=playground-image-${f.train}`,
    );
    assertEquals(
      f.calls.some((c) => c.includes("git/refs")),
      false,
      f.calls.join("\n"),
    );
  } finally {
    await f.cleanup();
  }
});

Deno.test("a real train with a ports commit off main stops before any dispatch", async () => {
  const f = await imageStepFixture({
    validate: 0,
    ports: "pr",
    kernel: "main",
  });
  try {
    assertEquals(f.code, 1, f.output);
    assertStringIncludes(f.output, "rehearse it with --validate");
    assertEquals(f.dispatches.length, 0, f.calls.join("\n"));
  } finally {
    await f.cleanup();
  }
});

Deno.test("a new real train with a kernel commit off main stops before its first dispatch and leaves no state", async () => {
  const f = await imageStepFixture({
    validate: 0,
    ports: "main",
    kernel: "pr",
    fresh: true,
  });
  try {
    assertEquals(f.code, 1, f.output);
    assertStringIncludes(f.output, "rehearse it with --validate");
    assertEquals(f.dispatches.length, 0, f.calls.join("\n"));
    assertEquals(f.stateLeft, false, "a refused train left its state file");
  } finally {
    await f.cleanup();
  }
});

Deno.test("a rehearsal of a sandbox commit off main builds the host and CLI from a validate branch and publishes nothing", async () => {
  const f = await imageStepFixture({
    validate: 1,
    ports: "main",
    kernel: "main",
    sandbox: "pr",
  });
  try {
    assertEquals(f.code, 0, f.output);
    const [image, native] = f.dispatches;
    assertStringIncludes(image, "--ref main");
    assertStringIncludes(native, "release-native.yml");
    assertStringIncludes(native, `--ref validate/${f.train}`);
    assertStringIncludes(native, "-f publish=false");
    assertStringIncludes(native, `-f sandbox_sha=${f.shas.sandbox.pr}`);
    assertEquals(f.dispatches.length, 2, f.calls.join("\n"));
    const calls = f.calls.join("\n");
    // Made in yurt-sandbox at its main's head, gone at the end; yurt-ports
    // gets no branch.
    assertStringIncludes(
      calls,
      `api -X POST repos/YurtOS/yurt-sandbox/git/refs -f ref=refs/heads/validate/${f.train} -f sha=${f.shas.sandbox.main}`,
    );
    assertStringIncludes(
      calls,
      `api -X DELETE repos/YurtOS/yurt-sandbox/git/refs/heads/validate/${f.train}`,
    );
    assertEquals(calls.includes("POST repos/YurtOS/yurt-ports"), false, calls);
    assertEquals(f.leftBranches, 0, "the validate branch was not deleted");
  } finally {
    await f.cleanup();
  }
});

Deno.test("a rehearsal of a kernel commit off main builds the host and CLI from a validate branch as well as the image", async () => {
  const f = await imageStepFixture({
    validate: 1,
    ports: "main",
    kernel: "pr",
  });
  try {
    assertEquals(f.code, 0, f.output);
    const [image, native] = f.dispatches;
    assertStringIncludes(image, `--ref validate/${f.train}`);
    assertStringIncludes(native, `--ref validate/${f.train}`);
    assertStringIncludes(native, "-f publish=false");
    assertEquals(f.leftBranches, 0, "a validate branch was not deleted");
  } finally {
    await f.cleanup();
  }
});

Deno.test("a new rehearsal of a sandbox commit off main records the validate branch and dispatches every step", async () => {
  const f = await imageStepFixture({
    validate: 1,
    ports: "main",
    kernel: "main",
    sandbox: "pr",
    fresh: true,
  });
  try {
    assertEquals(f.code, 0, f.output);
    const [kernel, image, native] = f.dispatches;
    assertStringIncludes(kernel, "release-kernel-wasm.yml");
    assertStringIncludes(kernel, "--ref main");
    assertStringIncludes(image, "--ref main");
    assertStringIncludes(native, `--ref validate/${f.train}`);
    assertStringIncludes(native, "-f publish=false");
    assertEquals(f.leftBranches, 0, "the validate branch was not deleted");
    assertEquals(f.stateLeft, false, "a finished rehearsal left its state");
  } finally {
    await f.cleanup();
  }
});

Deno.test("a new rehearsal stops while yurt-sandbox still has its validate branch", async () => {
  const f = await imageStepFixture({
    validate: 1,
    ports: "main",
    kernel: "main",
    sandbox: "pr",
    fresh: true,
    staleSandboxBranch: true,
  });
  try {
    assertEquals(f.code, 1, f.output);
    assertStringIncludes(f.output, "from an unfinished rehearsal");
    assertEquals(f.dispatches.length, 0, f.calls.join("\n"));
    assertEquals(f.stateLeft, false, "a refused train left its state file");
  } finally {
    await f.cleanup();
  }
});

Deno.test("a new real train with a sandbox commit off main stops before its first dispatch and leaves no state", async () => {
  const f = await imageStepFixture({
    validate: 0,
    ports: "main",
    kernel: "main",
    sandbox: "pr",
    fresh: true,
  });
  try {
    assertEquals(f.code, 1, f.output);
    assertStringIncludes(f.output, "host and CLI build only from both mains");
    assertStringIncludes(f.output, "rehearse it with --validate");
    assertEquals(f.dispatches.length, 0, f.calls.join("\n"));
    assertEquals(f.stateLeft, false, "a refused train left its state file");
  } finally {
    await f.cleanup();
  }
});

Deno.test("a new real train with a hand-cut image and a kernel commit off main stops before the kernel step", async () => {
  const f = await imageStepFixture({
    validate: 0,
    ports: "main",
    kernel: "pr",
    fresh: true,
    imageRelease: "playground-image-handcut",
  });
  try {
    assertEquals(f.code, 1, f.output);
    assertStringIncludes(f.output, "host and CLI build only from both mains");
    assertEquals(f.dispatches.length, 0, f.calls.join("\n"));
    assertEquals(f.stateLeft, false, "a refused train left its state file");
  } finally {
    await f.cleanup();
  }
});

Deno.test("a resumed real train from before the record, with a sandbox commit off main, stops before any dispatch", async () => {
  const f = await imageStepFixture({
    validate: 0,
    ports: "main",
    kernel: "main",
    sandbox: "pr",
  });
  try {
    assertEquals(f.code, 1, f.output);
    assertStringIncludes(f.output, "host and CLI build only from both mains");
    assertEquals(f.dispatches.length, 0, f.calls.join("\n"));
  } finally {
    await f.cleanup();
  }
});

Deno.test("a resumed rehearsal keeps its recorded validate branch for the host and CLI, unpublished", async () => {
  // The sandbox commit is on main now; the record, not a new decision, says
  // where [3] builds.
  const f = await imageStepFixture({
    validate: 1,
    ports: "main",
    kernel: "main",
    sandbox: "main",
    nativeRef: "validate/<train>",
  });
  try {
    assertEquals(f.code, 0, f.output);
    const native = f.dispatches.find((d) => d.includes("release-native.yml"));
    assertStringIncludes(native ?? "", `--ref validate/${f.train}`);
    assertStringIncludes(native ?? "", "-f publish=false");
    assertEquals(
      f.output.includes("native  built from"),
      false,
      "the resumed train decided again",
    );
    assertEquals(f.leftBranches, 0, "the validate branch was not deleted");
  } finally {
    await f.cleanup();
  }
});

Deno.test("a resumed real train keeps its recorded main for the host and CLI", async () => {
  const f = await imageStepFixture({
    validate: 0,
    ports: "main",
    kernel: "main",
    sandbox: "pr",
    nativeRef: "main",
  });
  try {
    // The record wins over the sandbox commit (off main here only to show
    // no decision ran); the train stops later, at the pins.
    const native = f.dispatches.find((d) => d.includes("release-native.yml"));
    assertStringIncludes(native ?? "", "--ref main");
    assertStringIncludes(native ?? "", "-f publish=true");
  } finally {
    await f.cleanup();
  }
});

Deno.test("a train stops when it cannot check a commit against main", async () => {
  const f = await imageStepFixture({
    validate: 1,
    ports: "main",
    kernel: "main",
    fresh: true,
    sandboxRoot: "missing-sandbox-checkout",
  });
  try {
    assertEquals(f.code, 1, f.output);
    assertStringIncludes(f.output, "no checkout at");
    assertEquals(f.dispatches.length, 0, f.calls.join("\n"));
    assertEquals(f.stateLeft, false, "a refused train left its state file");
  } finally {
    await f.cleanup();
  }
});

Deno.test("a new train records where the host and CLI build before its first step", async () => {
  const f = await imageStepFixture({
    validate: 1,
    ports: "main",
    kernel: "main",
    sandbox: "pr",
    fresh: true,
    failKernelRun: true,
  });
  try {
    assertEquals(f.code, 1, f.output);
    assertEquals(f.dispatches.length, 1, f.calls.join("\n"));
    assertEquals(f.state?.steps?.native?.ref, `validate/${f.train}`);
  } finally {
    await f.cleanup();
  }
});

// #236: the image workflow refuses a yurt_cli_release without the sha256 of
// the amd64 .deb its smoke installs (yurt_cli_sha256).
const cliInputs = [
  "-f yurt_cli_release=yurt-cli-pinned",
  "-f yurt_cli_repo=YurtOS/yurt-sandbox",
  `-f yurt_cli_sha256=${pinnedCliDebSha256}`,
];

Deno.test("a new train's image dispatch passes the pinned CLI .deb's sha256", async () => {
  // A rehearsal of both mains: [2] dispatches on main.
  for (const ports of ["main", "pr"] as const) {
    const f = await imageStepFixture({
      validate: 1,
      ports,
      kernel: "main",
      fresh: true,
    });
    try {
      assertEquals(f.code, 0, f.output);
      const image = f.dispatches.find((d) =>
        d.includes("release-playground-image.yml")
      );
      assertEquals(image !== undefined, true, f.calls.join("\n"));
      // A ports commit off main dispatches from validate/<train>, which
      // takes the same inputs.
      assertStringIncludes(
        image!,
        ports === "main" ? "--ref main" : `--ref validate/${f.train}`,
      );
      for (const input of cliInputs) assertStringIncludes(image!, input);
    } finally {
      await f.cleanup();
    }
  }
});

Deno.test("a resumed train from before #236 passes the pinned CLI .deb's sha256", async () => {
  // The fixture's state file has the shape a train started before this
  // change wrote: [1] done, [2] not dispatched, no CLI recorded.
  const f = await imageStepFixture({
    validate: 0,
    ports: "main",
    kernel: "main",
  });
  try {
    assertEquals(f.state.steps.image.yurt_cli_sha256, undefined);
    const image = f.dispatches.find((d) =>
      d.includes("release-playground-image.yml")
    );
    assertEquals(image !== undefined, true, f.output + f.calls.join("\n"));
    for (const input of cliInputs) assertStringIncludes(image!, input);
  } finally {
    await f.cleanup();
  }
});

Deno.test("a train stops before any dispatch when pins.json has no valid sha256 for the CLI's amd64 .deb", async () => {
  const linux = "x86_64-unknown-linux-gnu";
  const cases: [string, unknown, string][] = [
    [
      "no digest",
      { ...pinnedCli, sha256: { ...pinnedCli.sha256, [linux]: undefined } },
      "has no sha256",
    ],
    ["no yurtCli", {}, "names no yurtCli.release"],
    ["a yurtCli that is not an object", "x", "names no yurtCli.release"],
    [
      "a sha256 that is not a map",
      { ...pinnedCli, sha256: "f".repeat(64) },
      "has no sha256",
    ],
    [
      "no sha256 map",
      { ...pinnedCli, sha256: undefined },
      "has no sha256",
    ],
    [
      "a short digest",
      {
        ...pinnedCli,
        sha256: { ...pinnedCli.sha256, [linux]: "f".repeat(63) },
      },
      "has no sha256",
    ],
    [
      "an uppercase digest",
      {
        ...pinnedCli,
        sha256: { ...pinnedCli.sha256, [linux]: "F".repeat(64) },
      },
      "has no sha256",
    ],
    [
      "a tarball for the linux asset",
      {
        ...pinnedCli,
        assets: { ...pinnedCli.assets, [linux]: "yurt-x86_64-linux.tar.gz" },
      },
      "not the amd64 .deb",
    ],
  ];
  for (const [what, yurtCli, error] of cases) {
    for (const fresh of [true, false]) {
      const f = await imageStepFixture({
        validate: 1,
        ports: "main",
        kernel: "main",
        fresh,
        yurtCli,
      });
      try {
        assertEquals(f.code, 1, `${what}, fresh=${fresh}: ${f.output}`);
        assertStringIncludes(f.output, error);
        // Fresh: not even [1]; resumed ([1] done): not [2].
        assertEquals(f.dispatches, [], `${what}, fresh=${fresh}`);
        // A new train that stops leaves no state, so a rerun starts it.
        if (fresh) assertEquals(f.stateLeft, false, what);
      } finally {
        await f.cleanup();
      }
    }
  }
});

Deno.test("a real train pins its own CLI in [4], not the one [2]'s smoke installs", async () => {
  // #237 round 1: reading the smoke CLI into cli_release made [4] pin the
  // CLI pins.json already had instead of the train's yurt-cli-<train>.
  for (const fresh of [true, false]) {
    const f = await imageStepFixture({
      validate: 0,
      ports: "main",
      kernel: "main",
      fresh,
      stopAtPins: true,
    });
    try {
      assertEquals(f.code, 0, f.output);
      const image = f.dispatches.find((d) =>
        d.includes("release-playground-image.yml")
      );
      for (const input of cliInputs) assertStringIncludes(image!, input);
      assertStringIncludes(
        f.output,
        `PINS_CLI=YurtOS/yurt-sandbox@yurt-cli-${f.train}`,
      );
    } finally {
      await f.cleanup();
    }
  }
});

/** The script's own step_get and step_set lines, for a fixture state. */
function stepHelpers(source: string): string {
  const lines = source.split("\n").filter((line) =>
    /^step_(get|set)\(\) \{/.test(line)
  );
  assertEquals(lines.length, 2, "release-playground.sh has step_get/step_set");
  return lines.join("\n");
}

/** release-playground.sh's pins write, from the snapshot entry it reads
 * to the pins it verifies, run on a project whose pins carry a snapshot
 * entry, with a `deno` that answers --check-pin as `answer` (bash). */
async function pinsWrite(
  answer: string,
  initialState: unknown = { steps: {} },
  {
    pinsOnly = false,
    snapshots = { snapshot: { release: "snapshot-playground-old" } } as Record<
      string,
      unknown
    >,
  } = {},
) {
  const dir = await Deno.makeTempDir({ prefix: "release-pins-write-" });
  try {
    const root = join(dir, "project");
    await copyScriptLib(root);
    await Deno.mkdir(join(root, "artifacts"));
    await Deno.writeTextFile(
      join(root, "artifacts/pins.json"),
      JSON.stringify({ train: "playground-old", ...snapshots }),
    );
    const source = await Deno.readTextFile(
      join(repoRoot, "scripts/release-playground.sh"),
    );
    const start = "# The sealed sandbox snapshot (scripts/release-snapshot.ts)";
    // Through the pins' verification and the pins-only ending, to the pin
    // PR (step [4]).
    const end = "# [4] the pin PR, merged on a yes";
    assertEquals(source.includes(start) && source.includes(end), true);
    const block = start + source.split(start)[1].split(end)[0];
    const scriptPath = join(dir, "block.sh");
    await Deno.writeTextFile(
      scriptPath,
      `set -euo pipefail
say() { printf '==> %s\\n' "$*" >&2; }
die() { echo "release-playground: $*" >&2; exit 1; }
resume_command() { echo "resume"; }
root=${JSON.stringify(root)}
pins_only=${pinsOnly ? 1 : 0}
state=${JSON.stringify(join(dir, "state.json"))}
echo ${JSON.stringify(JSON.stringify(initialState))} > "$state"
${stepHelpers(source)}
source "$root/scripts/lib/snapshot-pin.sh"
train=playground-new kernel_sha=k sandbox_sha=s ports_sha=p
kernel_wasm_release=kw kernel_wasm_repo=r kernel_sha256=ks
image_release=ir image_repo=r image_sha256=is
host_release=hr host_repo=r cli_release=cr cli_repo=r
host_json='{}' cli_json='{}' python_seal_json='{"sha256":"py"}' slim_json=null
${block}
printf 'DROPPED=%s\\n' "\${snapshot_dropped:-0}"
`,
    );
    // The pins' verification: not this test's.
    await Deno.writeTextFile(
      join(root, "scripts/install-pinned-artifacts.sh"),
      "#!/bin/sh\nexit 0\n",
    );
    await Deno.chmod(join(root, "scripts/install-pinned-artifacts.sh"), 0o755);
    const bin = join(dir, "bin");
    await Deno.mkdir(bin);
    await Deno.writeTextFile(
      join(bin, "deno"),
      // Called as the script calls it, from the project root; any other
      // call is no verdict (exit 9), which stops the train.
      // \`kind\` is the snapshot asked about (--kind, desktop without it).
      `#!/usr/bin/env bash
case "$*" in
  "run -A scripts/release-snapshot.ts --check-pin") kind=desktop ;;
  "run -A scripts/release-snapshot.ts --check-pin --kind tablet") kind=tablet ;;
  "run -A scripts/release-snapshot.ts --check-pin --kind phone") kind=phone ;;
  *) exit 9 ;;
esac
[ "$(pwd -P)" = "$(cd ${JSON.stringify(root)} && pwd -P)" ] || exit 9
${answer}
`,
    );
    await Deno.chmod(join(bin, "deno"), 0o755);
    const result = await command("bash", [scriptPath], {
      env: { PATH: `${bin}:${Deno.env.get("PATH") ?? ""}` },
    });
    return {
      code: result.code,
      output: new TextDecoder().decode(result.stdout) +
        new TextDecoder().decode(result.stderr),
      pins: JSON.parse(
        await Deno.readTextFile(join(root, "artifacts/pins.json")),
      ),
      state: JSON.parse(await Deno.readTextFile(join(dir, "state.json"))),
    };
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("a train carries the snapshot pin --check-pin accepts into its new pins", async () => {
  // A resumed train whose earlier run dropped the pin, and whose pins now
  // keep one: nothing is left to recapture.
  const run = await pinsWrite("exit 0", {
    steps: { snapshot: { dropped: "an earlier refusal" } },
  });
  assertEquals(run.code, 0, run.output);
  assertEquals(run.pins.train, "playground-new");
  assertEquals(run.pins.snapshot, { release: "snapshot-playground-old" });
  assertStringIncludes(run.output, "DROPPED=0");
  assertEquals(run.state.steps.snapshot, { dropped: null });
});

Deno.test("a train carries every device's snapshot pin, each checked by its own kind", async () => {
  const run = await pinsWrite(
    `[ "$kind" = tablet ] || exit 0
echo 'snapshot pin refused: built from bootSetup 1, not 2' >&2; exit 3`,
    { steps: {} },
    {
      snapshots: {
        snapshot: { release: "d" },
        tabletSnapshot: { release: "t" },
        phoneSnapshot: { release: "p" },
      },
    },
  );
  assertEquals(run.code, 0, run.output);
  assertEquals(run.pins.snapshot, { release: "d" });
  assertEquals(run.pins.phoneSnapshot, { release: "p" });
  assertEquals("tabletSnapshot" in run.pins, false);
  assertStringIncludes(
    run.output,
    "the pinned snapshot is not this train's (tabletSnapshot: built from bootSetup 1, not 2): dropped",
  );
  assertStringIncludes(run.output, "DROPPED=1");
});

Deno.test("a resumed train keeps an earlier run's dropped tablet or phone pin until it is back", async () => {
  // The earlier run dropped the tablet's; this one keeps the desktop's.
  const still = await pinsWrite(
    "exit 0",
    {
      steps: {
        snapshot: { dropped: "tabletSnapshot: built from bootSetup 1, not 2" },
      },
    },
    { snapshots: { snapshot: { release: "d" } } },
  );
  assertEquals(still.code, 0, still.output);
  assertEquals(still.state.steps.snapshot, {
    dropped: "tabletSnapshot: built from bootSetup 1, not 2",
  });
  // Once a recapture put it back, nothing is left to remind of.
  const back = await pinsWrite(
    "exit 0",
    {
      steps: {
        snapshot: { dropped: "tabletSnapshot: built from bootSetup 1, not 2" },
      },
    },
    {
      snapshots: {
        snapshot: { release: "d" },
        tabletSnapshot: { release: "t" },
      },
    },
  );
  assertEquals(back.code, 0, back.output);
  assertEquals(back.state.steps.snapshot, { dropped: null });
});

Deno.test("a resumed train that drops another pin keeps an earlier run's record of a pin still absent", async () => {
  // The earlier run dropped the tablet's; this one refuses the desktop's.
  const run = await pinsWrite(
    "echo 'snapshot pin refused: built from kernelRev a, not b; imageSha256 c, not d' >&2; exit 3",
    { steps: { snapshot: { dropped: "tabletSnapshot: built from x, not y" } } },
    { snapshots: { snapshot: { release: "d" } } },
  );
  assertEquals(run.code, 0, run.output);
  assertEquals(run.state.steps.snapshot, {
    dropped:
      "built from kernelRev a, not b; imageSha256 c, not d\ntabletSnapshot: built from x, not y",
  });
  // A reason holding "; " is still one pin's line: once the tablet's is
  // back, its record clears (no desktop pin on this train).
  const back = await pinsWrite(
    "exit 0",
    {
      steps: {
        snapshot: {
          dropped:
            "tabletSnapshot: built from kernelRev a, not b; imageSha256 c, not d",
        },
      },
    },
    { snapshots: { tabletSnapshot: { release: "t" } } },
  );
  assertEquals(back.code, 0, back.output);
  assertEquals(back.state.steps.snapshot, { dropped: null });
});

Deno.test("a train drops the snapshot pin --check-pin refuses, with its reason", async () => {
  const run = await pinsWrite(
    "echo 'snapshot pin refused: built from kernelRev k0, not k' >&2; exit 3",
  );
  assertEquals(run.code, 0, run.output);
  assertEquals(run.pins.train, "playground-new");
  assertEquals("snapshot" in run.pins, false);
  assertStringIncludes(
    run.output,
    "the pinned snapshot is not this train's (built from kernelRev k0, not k): dropped",
  );
  assertStringIncludes(run.output, "DROPPED=1");
  // Kept with the train, for a --resume's closing reminder.
  assertEquals(run.state.steps.snapshot, {
    dropped: "built from kernelRev k0, not k",
  });
});

Deno.test("a pins-only train that dropped the pin ends with the reminder to recapture", async () => {
  const dropped = await pinsWrite(
    "echo 'snapshot pin refused: built from kernelRev k0, not k' >&2; exit 3",
    { steps: {} },
    { pinsOnly: true },
  );
  assertEquals(dropped.code, 0, dropped.output);
  assertStringIncludes(
    dropped.output,
    "the snapshot pin was dropped (built from kernelRev k0, not k): run scripts/release-snapshot.ts",
  );
  assertStringIncludes(dropped.output, "pins regenerated and verified");
  const kept = await pinsWrite("exit 0", { steps: {} }, { pinsOnly: true });
  assertEquals(kept.output.includes("the snapshot pin was dropped"), false);
});

Deno.test("a train ends with the reminder to recapture when its state says the pin was dropped", async () => {
  const dir = await Deno.makeTempDir({ prefix: "release-reminder-" });
  try {
    const source = await Deno.readTextFile(
      join(repoRoot, "scripts/release-playground.sh"),
    );
    // The train's own ending, from its last report to the end of the file.
    const start = 'say "released: ';
    assertEquals(source.includes(start), true);
    const ending = start + source.split(start).at(-1);
    const run = async (steps: unknown) => {
      const state = join(dir, "state.json");
      await Deno.writeTextFile(state, JSON.stringify({ steps }));
      const result = await command("bash", [
        "-c",
        `set -euo pipefail
say() { printf '==> %s\\n' "$*"; }
source "$1"
state=${JSON.stringify(state)}
train=t image_release=i seal_release_of_train=s
${stepHelpers(source)}
${ending}`,
        "bash",
        join(repoRoot, "scripts/lib/snapshot-pin.sh"),
      ]);
      return new TextDecoder().decode(result.stdout);
    };
    assertStringIncludes(
      await run({ snapshot: { dropped: "built from kernelRev k0, not k" } }),
      "the snapshot pin was dropped (built from kernelRev k0, not k): run scripts/release-snapshot.ts",
    );
    for (const steps of [{}, { snapshot: { dropped: null } }]) {
      assertEquals(
        (await run(steps)).includes("the snapshot pin was dropped"),
        false,
        JSON.stringify(steps),
      );
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a train stops when --check-pin gives no verdict, and keeps the pin", async () => {
  const run = await pinsWrite("echo 'error: Uncaught' >&2; exit 1");
  assertEquals(run.code, 1, run.output);
  assertStringIncludes(
    run.output,
    "release-snapshot.ts --check-pin failed (exit 1)",
  );
  assertEquals(run.pins.snapshot, { release: "snapshot-playground-old" });
});

Deno.test("a train whose pin PR is left open still reminds to recapture a dropped pin", async () => {
  const dir = await Deno.makeTempDir({ prefix: "release-left-open-" });
  try {
    const source = await Deno.readTextFile(
      join(repoRoot, "scripts/release-playground.sh"),
    );
    // The script's own question, up to its answer's case.
    const start = 'if [ "$pr_state" != MERGED ]; then';
    assertEquals(source.includes(start), true);
    const question = start + source.split(start)[1].split("  esac")[0] +
      "  esac\nfi\n";
    const state = join(dir, "state.json");
    await Deno.writeTextFile(
      state,
      JSON.stringify({ steps: { snapshot: { dropped: "built from k0" } } }),
    );
    const scriptPath = join(dir, "question.sh");
    await Deno.writeTextFile(
      scriptPath,
      `set -euo pipefail
say() { printf '==> %s\\n' "$*"; }
source ${JSON.stringify(join(repoRoot, "scripts/lib/snapshot-pin.sh"))}
state=${JSON.stringify(state)}
pr_state=OPEN pr_url=https://example.invalid/pull/1
${stepHelpers(source)}
${question}
echo NOT-REACHED
`,
    );
    const result = await new Deno.Command("bash", {
      args: [scriptPath],
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
      clearEnv: true,
      env: fixtureEnv(),
    }).spawn();
    const writer = result.stdin.getWriter();
    await writer.write(new TextEncoder().encode("n\n"));
    await writer.close();
    const out = await result.output();
    const output = new TextDecoder().decode(out.stdout);
    assertEquals(out.code, 0, new TextDecoder().decode(out.stderr));
    assertStringIncludes(output, "left open: https://example.invalid/pull/1");
    assertStringIncludes(
      output,
      "the snapshot pin was dropped (built from k0): run scripts/release-snapshot.ts",
    );
    assertEquals(output.includes("NOT-REACHED"), false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

/** Runs `body` in bash with scripts/lib/python-set.sh sourced, and `curl`
 * answering each yurt-packages package file from `packages` (name ->
 * `version@build` list, `!` for yanked). */
async function pythonSetLib(
  body: string,
  packages: Record<string, string[]> = {},
): Promise<{ code: number; stdout: string }> {
  const dir = await Deno.makeTempDir({ prefix: "python-set-" });
  try {
    const bin = join(dir, "bin");
    await Deno.mkdir(join(dir, "packages"), { recursive: true });
    await Deno.mkdir(bin);
    for (const [name, list] of Object.entries(packages)) {
      await Deno.writeTextFile(
        join(dir, "packages", `${name}.json`),
        JSON.stringify({
          name,
          versions: list.map((r) => {
            const [version, build] = r.replace("!", "").split("@");
            return { version, build, yanked: r.startsWith("!") };
          }),
        }),
      );
    }
    await Deno.writeTextFile(
      join(bin, "curl"),
      `#!/usr/bin/env bash
url=\${!#}
cat ${JSON.stringify(join(dir, "packages"))}/"\${url##*/}"
`,
    );
    await Deno.chmod(join(bin, "curl"), 0o755);
    const result = await command("bash", [
      "-c",
      `set -euo pipefail; source ${
        JSON.stringify(join(repoRoot, "scripts/lib/python-set.sh"))
      }; cd ${JSON.stringify(dir)}; ${body}`,
    ], { env: { PATH: `${bin}:${Deno.env.get("PATH") ?? ""}` } });
    return {
      code: result.code,
      stdout: new TextDecoder().decode(result.stdout).trim(),
    };
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

const SET_AT = (builds: number[], python = "3.14.7") => ({
  python: builds.map((n) => `${python}@yurt_${n}`),
  numpy: builds.map((n) => `2.5.0@yurt_${n}`),
  pyzmq: builds.map((n) => `26.4.0@yurt_${n}`),
  "jupyter-kernel": builds.map((n) => `0.0.1@yurt_${n}`),
  "python-seal": builds.map((n) => `3.14.7@yurt_${n}`),
});

Deno.test("the slim image's python is read from its own pkg installed list", async () => {
  const image = (list?: string) => `
mkdir -p root/var/lib/yurt-pkg root/bin
touch root/bin/busybox
${
    list === undefined
      ? ""
      : `printf ${JSON.stringify(list)} > root/var/lib/yurt-pkg/installed.list`
  }
(cd root && tar -cf - bin var) | zstd -q -o slim.yurtimg
slim_image_python slim.yurtimg`;
  assertEquals(
    (await pythonSetLib(image(
      "ca-certificates\\t2026.9.25\\tyurt_0\\npython\\t3.14.7\\tyurt_0\\n",
    ))).stdout,
    "3.14.7 yurt_0",
  );
  // Today's slim image: a list without python, or (older) none at all.
  assertEquals(
    (await pythonSetLib(image("git\\t2.55.0\\tyurt_0\\n"))).stdout,
    "",
  );
  assertEquals((await pythonSetLib(image())).stdout, "");
  // Not an image at all.
  assertEquals(
    (await pythonSetLib("echo x > bad; slim_image_python bad")).code !== 0,
    true,
  );
});

Deno.test("a train needs a complete live Python set at the slim image's python build, not just the newest", async () => {
  // python at yurt_0 with yurt_0's set still live beside yurt_1's.
  assertEquals(
    (await pythonSetLib("python_set_builds 3.14.7 yurt_0", SET_AT([0, 1])))
      .stdout,
    "yurt_0",
  );
  // Only yurt_1 live: nothing the image can take.
  const newer = { ...SET_AT([1]), numpy: ["2.5.0@yurt_0", "2.5.0@yurt_1"] };
  assertEquals(
    (await pythonSetLib("python_set_builds 3.14.7 yurt_0", newer)).stdout,
    "",
  );
  // yurt_0 live, but with another python version than the image's.
  assertEquals(
    (await pythonSetLib(
      "python_set_builds 3.14.7 yurt_0",
      SET_AT([0], "3.14.8"),
    )).stdout,
    "",
  );
  // No python in the image: every complete build, newest last, as before;
  // a yanked member takes its build out.
  const yanked = {
    ...SET_AT([0, 1, 2]),
    pyzmq: ["26.4.0@yurt_0", "!26.4.0@yurt_1", "26.4.0@yurt_2"],
  };
  assertEquals(
    (await pythonSetLib("python_set_builds", yanked)).stdout,
    "yurt_0\nyurt_2",
  );
});
