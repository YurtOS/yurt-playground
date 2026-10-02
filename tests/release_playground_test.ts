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
    await Deno.copyFile(
      join(repoRoot, "scripts/lib/kernel-release.sh"),
      join(harnessRoot, "scripts/lib/kernel-release.sh"),
    );
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
    await Deno.copyFile(
      join(repoRoot, "scripts/lib/kernel-release.sh"),
      join(root, "scripts/lib/kernel-release.sh"),
    );
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
        steps: { kernel_wasm: { run_id: 123 } },
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
