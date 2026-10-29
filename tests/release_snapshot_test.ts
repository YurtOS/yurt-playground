import { assertEquals, assertRejects } from "@std/assert";
import {
  captureSetProblem,
  checkoutProblem,
  checkPin,
  PIN_REFUSED_EXIT,
  releaseNotes,
  releaseProblems,
  snapshotPinProblem,
  withoutGitVariables,
} from "../scripts/release-snapshot.ts";
import { sha256Hex } from "../src/integrity.ts";
import { livePythonSet, NO_COMPLETE_SET } from "../src/python_install.ts";
import { checkSnapshotFile } from "../scripts/lib/snapshot_file.ts";
import { encodeSandboxSnapshot } from "../src/sandbox_snapshot.ts";

const part = (i: number, sha: string, size = 10) => ({
  name: `sandbox.seal.gz.${i}`,
  sha256: sha.repeat(64),
  size,
});
const asset = (p: ReturnType<typeof part>) => ({
  name: p.name,
  size: p.size,
  digest: `sha256:${p.sha256}`,
});

Deno.test("an existing snapshot release counts only when it holds every part, by sha256 and size", () => {
  const parts = [part(0, "a"), part(1, "b"), part(2, "c", 4)];
  const sidecar = { name: "sandbox.seal.gz.sha256", size: 83, digest: null };
  assertEquals(releaseProblems([...parts.map(asset), sidecar], parts), []);
  assertEquals(releaseProblems([asset(parts[0]), asset(parts[2])], parts), [
    "sandbox.seal.gz.1 is missing",
  ]);
  assertEquals(
    releaseProblems([
      asset(parts[0]),
      { ...asset(parts[1]), digest: `sha256:${"f".repeat(64)}` },
      { ...asset(parts[2]), size: 5 },
    ], parts),
    [
      `sandbox.seal.gz.1 has sha256 ${"f".repeat(64)}, not ${"b".repeat(64)}`,
      "sandbox.seal.gz.2 is 5 bytes, not 4",
    ],
  );
  // An asset GitHub reports no digest for proves nothing.
  assertEquals(
    releaseProblems([asset(parts[0]), asset(parts[1]), {
      ...asset(parts[2]),
      digest: null,
    }], parts),
    [`sandbox.seal.gz.2 has sha256 (none), not ${"c".repeat(64)}`],
  );
});

Deno.test("only the deploy fetches the snapshot, with the other blobs' retry", async () => {
  const read = (path: string) =>
    Deno.readTextFile(new URL(`../${path}`, import.meta.url));
  const script = await read("scripts/install-pinned-artifacts.sh");
  assertEquals(
    /YURT_INSTALL_SNAPSHOT:-\}" == 1 \]\]; then\s+if ! install_snapshot; then/
      .test(script),
    true,
    "the snapshot is installed behind YURT_INSTALL_SNAPSHOT=1",
  );
  assertEquals(
    /install_snapshot\(\) \([^]*download "\$tag" "\$repo" 'sandbox\.seal\.gz/
      .test(script),
    true,
    "through download(), the other blobs' retry",
  );
  assertEquals(
    (await read(".github/workflows/deploy-pages.yml")).includes(
      'YURT_INSTALL_SNAPSHOT: "1"',
    ),
    true,
  );
  for (const workflow of ["ci.yml", "release-desktop.yml"]) {
    assertEquals(
      (await read(`.github/workflows/${workflow}`)).includes(
        "YURT_INSTALL_SNAPSHOT",
      ),
      false,
      workflow,
    );
  }
});

Deno.test("a train keeps the snapshot pin only when --check-pin's checks pass", async () => {
  const { snapshotIdentity, FORMAT } = await import(
    "../src/sandbox_snapshot.ts"
  );
  const { parsePins } = await import("../src/pins.ts");
  const raw = JSON.parse(
    await Deno.readTextFile(new URL("../artifacts/pins.json", import.meta.url)),
  );
  const pins = parsePins({ ...raw, snapshot: undefined });
  const set = "img/python@3.14.7-yurt_0:0123456789abcdef";
  const entry = {
    releaseRepo: "YurtOS/yurt-playground",
    release: "snapshot-t",
    format: FORMAT,
    sha256: "a".repeat(64),
    size: 1,
    parts: ["b".repeat(64)],
    builtFrom: { ...snapshotIdentity(pins), pythonSet: set },
  };
  const check = (snapshot: unknown, answer: string | null | undefined) =>
    snapshotPinProblem({ ...pins, snapshot }, () => Promise.resolve(answer));
  assertEquals(await check(entry, set), undefined);
  // The index cannot be read in time: kept, as the page restores it then.
  assertEquals(await check(entry, undefined), undefined);
  // Read, but no complete set: the page refuses, so does the train.
  assertEquals(
    (await check(entry, NO_COMPLETE_SET))?.includes(NO_COMPLETE_SET),
    true,
  );
  assertEquals(
    (await check(entry, "img/python@3.14.8-yurt_0:fedcba9876543210"))
      ?.includes("the live index offers"),
    true,
  );
  assertEquals(
    (await check({ ...entry, format: FORMAT - 1 }, set))?.includes("format"),
    true,
  );
  assertEquals(
    (await check({
      ...entry,
      builtFrom: { ...entry.builtFrom, kernelRev: "0" },
    }, set))?.includes("kernelRev"),
    true,
  );
  assertEquals((await check("old shape", set))?.includes("malformed"), true);
  // A crash is no verdict: it is thrown, never a refusal.
  await assertRejects(
    () =>
      snapshotPinProblem(
        { ...pins, snapshot: entry },
        () => Promise.reject(new TypeError("crash")),
      ),
    TypeError,
    "crash",
  );
});

Deno.test("a snapshot is released only from the pinned kernel rev and a pushed playground head, both clean", async () => {
  const dir = await Deno.makeTempDir();
  const remote = await Deno.makeTempDir();
  const git = async (cwd: string, ...args: string[]) => {
    const out = await new Deno.Command("git", {
      args: ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...args],
      stdout: "piped",
      stderr: "null",
      // A hook's GIT_DIR or GIT_INDEX_FILE would point elsewhere: every
      // other variable (an SSH agent, a proxy) is kept.
      clearEnv: true,
      env: withoutGitVariables(),
    }).output();
    return new TextDecoder().decode(out.stdout).trim();
  };
  const commit = async (content: string) => {
    await Deno.writeTextFile(`${dir}/a`, content);
    await git(dir, "add", "a", "deno.lock");
    await git(dir, "commit", "-q", "-m", content);
  };
  try {
    await git(dir, "init", "-q", "-b", "main");
    await Deno.writeTextFile(`${dir}/deno.lock`, "{}");
    await commit("1");
    const head = await git(dir, "rev-parse", "HEAD");
    // The kernel checkout: the pinned rev, its lockfile aside.
    assertEquals(await checkoutProblem(dir, head, ["deno.lock"]), undefined);
    await Deno.writeTextFile(`${dir}/deno.lock`, '{"npm":{}}');
    assertEquals(await checkoutProblem(dir, head, ["deno.lock"]), undefined);
    assertEquals(
      (await checkoutProblem(dir, head))?.includes("uncommitted changes"),
      true,
    );
    assertEquals(
      (await checkoutProblem(dir, "0".repeat(40)))?.includes(
        `is at ${head}, not the pinned ${"0".repeat(40)}`,
      ),
      true,
    );
    await Deno.writeTextFile(`${dir}/a`, "2");
    assertEquals(
      (await checkoutProblem(dir, head, ["deno.lock"]))?.includes(
        "uncommitted changes",
      ),
      true,
    );
    await git(dir, "checkout", "-q", "--", "a", "deno.lock");
    // The playground checkout: its pushed head.
    assertEquals(
      (await checkoutProblem(dir, "upstream"))?.startsWith(
        "cannot read the checkout",
      ),
      true,
      "no upstream",
    );
    await git(remote, "init", "-q", "--bare", "-b", "main");
    await git(dir, "remote", "add", "origin", remote);
    await git(dir, "push", "-q", "-u", "origin", "main");
    assertEquals(await checkoutProblem(dir, "upstream"), undefined);
    // Someone pushed since the last fetch: the remote's head counts.
    const other = await Deno.makeTempDir();
    await git(other, "clone", "-q", "-b", "main", remote, ".");
    await Deno.writeTextFile(`${other}/b`, "b");
    await git(other, "add", "b");
    await git(other, "commit", "-q", "-m", "b");
    await git(other, "push", "-q");
    await Deno.remove(other, { recursive: true });
    assertEquals(
      (await checkoutProblem(dir, "upstream"))?.includes("not its pushed head"),
      true,
      "a stale upstream is fetched first",
    );
    await git(dir, "pull", "-q", "--ff-only");
    const pulled = await git(dir, "rev-parse", "HEAD");
    await commit("3");
    assertEquals(
      (await checkoutProblem(dir, "upstream"))?.includes(
        `not its pushed head ${pulled}`,
      ),
      true,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
    await Deno.remove(remote, { recursive: true });
  }
});

Deno.test("a damaged or missing snapshot file is a problem to report, never a throw", async () => {
  const built = {
    kernelSha256: "a".repeat(64),
    kernelRev: "r",
    sealVersion: 1,
    bootSetup: 1,
    imageSha256: "b".repeat(64),
    pythonSealSha256: null,
    pythonSet: null,
  };
  const seal = {
    version: 1 as const,
    kernelToken: 1n,
    kernelMemory: new Uint8Array(1 << 16).fill(7),
    processes: [],
    hostWaits: [],
    monotonicNs: 0n,
    realtimeOffsetNs: 0n,
    executor: { contexts: [], freeScratch: [] },
  };
  const file = new Uint8Array(
    await (await encodeSandboxSnapshot(seal, built)).arrayBuffer(),
  );
  const dir = await Deno.makeTempDir();
  const path = `${dir}/sandbox.seal.gz`;
  try {
    await Deno.writeFile(path, file);
    const good = await checkSnapshotFile(path, built, { decode: true });
    assertEquals(good, { ok: true, builtFrom: built });
    // Cut after the header: the header check alone passes, a decode not.
    await Deno.writeFile(path, file.subarray(0, file.byteLength - 8));
    assertEquals((await checkSnapshotFile(path, built)).ok, true);
    assertEquals(
      (await checkSnapshotFile(path, built, { decode: true })).ok,
      false,
    );
    await Deno.writeFile(path, new TextEncoder().encode("not gzip at all"));
    assertEquals((await checkSnapshotFile(path, built)).ok, false);
    const missing = await checkSnapshotFile(`${dir}/none`, built);
    assertEquals(missing, { ok: false, problem: `${dir}/none is missing` });
    await Deno.writeFile(path, file);
    assertEquals(
      (await checkSnapshotFile(path, built, { sha256: "0".repeat(64) })).ok,
      false,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

/** install-pinned-artifacts.sh run on its own tree, with a `gh` that
 * serves each release asset as its name's bytes ("<asset>" in UTF-8) and
 * fails for the snapshot when `failSnapshot` is set. */
async function installWith(
  snapshot: unknown,
  { failSnapshot = false } = {},
) {
  const root = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${root}/scripts`);
    await Deno.mkdir(`${root}/artifacts`);
    await Deno.mkdir(`${root}/public/demo`, { recursive: true });
    await Deno.mkdir(`${root}/bin`);
    await Deno.copyFile(
      new URL("../scripts/install-pinned-artifacts.sh", import.meta.url),
      `${root}/scripts/install-pinned-artifacts.sh`,
    );
    const sha = async (text: string) =>
      [
        ...new Uint8Array(
          await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
        ),
      ].map((b) => b.toString(16).padStart(2, "0")).join("");
    const pin = async (asset: string) => ({
      release: "r",
      sha256: await sha(asset),
    });
    await Deno.writeTextFile(
      `${root}/artifacts/pins.json`,
      JSON.stringify({
        kernelWasm: await pin("kernel-wasm.wasm"),
        image: await pin("playground-image.yurtimg"),
        pythonSeal: await pin("python3-seal.wasm"),
        ...(snapshot === undefined ? {} : { snapshot }),
      }),
    );
    // gh release download TAG --repo R --pattern P --dir D --clobber
    await Deno.writeTextFile(
      `${root}/bin/gh`,
      `#!/usr/bin/env bash
pattern=$7; dir=$9; mkdir -p "$dir"
case $pattern in
  sandbox.seal.gz.*) ${
        failSnapshot ? 'echo "HTTP 404: Not Found" >&2; exit 1' : ""
      }
    printf 'snap' > "$dir/sandbox.seal.gz.0" ;;
  *) printf '%s' "$pattern" > "$dir/$pattern" ;;
esac
`,
    );
    await Deno.chmod(`${root}/bin/gh`, 0o755);
    const out = await new Deno.Command("bash", {
      args: [`${root}/scripts/install-pinned-artifacts.sh`],
      env: {
        PATH: `${root}/bin:${Deno.env.get("PATH")}`,
        YURT_INSTALL_SNAPSHOT: "1",
      },
      stdout: "piped",
      stderr: "piped",
    }).output();
    const installed = await Deno.stat(
      `${root}/public/snapshot/sandbox.seal.gz`,
    ).then(() => true, () => false);
    return {
      code: out.code,
      stderr: new TextDecoder().decode(out.stderr),
      installed,
      snapSha: await sha("snap"),
    };
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

Deno.test("a deploy never fails on the optional snapshot: any problem is a warning and no snapshot", async () => {
  const good = (sha256: string) => ({
    releaseRepo: "YurtOS/yurt-playground",
    release: "snapshot-t",
    sha256,
    parts: ["x"],
  });
  const ok = await installWith(good((await installWith(undefined)).snapSha));
  assertEquals([ok.code, ok.installed], [0, true], ok.stderr);
  for (
    const [why, snapshot, options] of [
      ["a wrong sha256", good("0".repeat(64)), {}],
      ["a failed download", good("0".repeat(64)), { failSnapshot: true }],
      ["a malformed entry", { release: 7 }, {}],
      ["an older shape", "snapshot-t", {}],
    ] as const
  ) {
    const run = await installWith(snapshot, options);
    assertEquals(run.code, 0, `${why}: ${run.stderr}`);
    assertEquals(run.installed, false, why);
    assertEquals(run.stderr.includes("WARNING"), true, why);
  }
});

Deno.test("--check-pin reads the pins file and answers for its snapshot entry", async () => {
  const { snapshotIdentity, FORMAT } = await import(
    "../src/sandbox_snapshot.ts"
  );
  const { parsePins } = await import("../src/pins.ts");
  const raw = JSON.parse(
    await Deno.readTextFile(new URL("../artifacts/pins.json", import.meta.url)),
  );
  const set = "img/python@3.14.7-yurt_0:0123456789abcdef";
  const entry = {
    releaseRepo: "YurtOS/yurt-playground",
    release: "snapshot-t",
    format: FORMAT,
    sha256: "a".repeat(64),
    size: 1,
    parts: ["b".repeat(64)],
    builtFrom: {
      ...snapshotIdentity(parsePins({ ...raw, snapshot: undefined })),
      pythonSet: set,
    },
  };
  const dir = await Deno.makeTempDir();
  const path = `${dir}/pins.json`;
  const asked: unknown[] = [];
  const live = (answer: string | undefined) => (pins: unknown) => () => {
    asked.push(pins);
    return Promise.resolve(answer);
  };
  try {
    await Deno.writeTextFile(path, JSON.stringify({ ...raw, snapshot: entry }));
    assertEquals(await checkPin(path, live(set)), { ok: true });
    assertEquals(asked.length, 1, "the live set was asked for these pins");
    assertEquals(await checkPin(path, live(undefined)), { ok: true });
    const refused = await checkPin(path, live("another set"));
    assertEquals(
      !refused.ok && refused.problem.includes("the live index offers"),
      true,
    );
    // No entry at all: nothing to keep.
    await Deno.writeTextFile(
      path,
      JSON.stringify({ ...raw, snapshot: undefined }),
    );
    const none = await checkPin(path, live(set));
    assertEquals(!none.ok && none.problem.includes("pins no"), true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("git runs with the caller's environment but a hook's GIT_* variables", () => {
  const set = {
    GIT_INDEX_FILE: "/elsewhere/index",
    GIT_DIR: "/elsewhere/.git",
    GIT_SSH_COMMAND: "ssh -i key",
    GIT_ASKPASS: "/askpass",
    GIT_SSL_CAINFO: "/ca.pem",
    SSH_AUTH_SOCK: "/agent.sock",
  };
  const before = Object.fromEntries(
    Object.keys(set).map((name) => [name, Deno.env.get(name)]),
  );
  for (const [name, value] of Object.entries(set)) Deno.env.set(name, value);
  try {
    const env = withoutGitVariables();
    assertEquals(env.GIT_INDEX_FILE, undefined);
    assertEquals(env.GIT_DIR, undefined);
    assertEquals(env.GIT_SSH_COMMAND, "ssh -i key");
    assertEquals(env.GIT_ASKPASS, "/askpass");
    assertEquals(env.GIT_SSL_CAINFO, "/ca.pem");
    assertEquals(env.SSH_AUTH_SOCK, "/agent.sock");
  } finally {
    for (const [name, value] of Object.entries(before)) {
      if (value === undefined) Deno.env.delete(name);
      else Deno.env.set(name, value);
    }
  }
});

Deno.test("an index that does not answer in time is 'cannot tell', not a hang", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch =
    ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise((_, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(init.signal!.reason),
        );
      })) as typeof fetch;
  try {
    const started = performance.now();
    assertEquals(
      await livePythonSet({ set: ["python"], image: "img" }, 30),
      undefined,
    );
    assertEquals(performance.now() - started < 5_000, true);
  } finally {
    globalThis.fetch = realFetch;
  }
});

Deno.test("release-snapshot.ts --check-pin answers through its exit code and says why", async () => {
  const raw = JSON.parse(
    await Deno.readTextFile(new URL("../artifacts/pins.json", import.meta.url)),
  );
  const dir = await Deno.makeTempDir();
  const path = `${dir}/pins.json`;
  const run = async () => {
    const out = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "-A",
        new URL("../scripts/release-snapshot.ts", import.meta.url).pathname,
        "--check-pin",
        "--pins",
        path,
      ],
      stdout: "piped",
      stderr: "piped",
    }).output();
    return { code: out.code, stderr: new TextDecoder().decode(out.stderr) };
  };
  try {
    // Refused before the live index is asked: no network in this test.
    await Deno.writeTextFile(path, JSON.stringify({ ...raw, snapshot: "old" }));
    const malformed = await run();
    assertEquals(malformed.code, PIN_REFUSED_EXIT);
    assertEquals(
      /^snapshot pin refused: .*malformed/m.test(malformed.stderr),
      true,
      malformed.stderr,
    );
    await Deno.writeTextFile(
      path,
      JSON.stringify({ ...raw, snapshot: undefined }),
    );
    const none = await run();
    assertEquals(none.code, PIN_REFUSED_EXIT);
    assertEquals(none.stderr.includes("pins no"), true, none.stderr);
    // A pins file that cannot be read is no verdict: exit 1.
    await Deno.writeTextFile(path, "{");
    assertEquals((await run()).code, 1);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

/** keep_snapshot_pin (scripts/lib/snapshot-pin.sh) on pins with a
 * snapshot entry, with a `deno` that runs `answer` (bash), or none. */
async function keepPin(
  answer: string | undefined,
  { readOnly = false, failingMv = false } = {},
) {
  const root = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${root}/artifacts`);
    await Deno.mkdir(`${root}/bin`);
    await Deno.writeTextFile(
      `${root}/artifacts/pins.json`,
      JSON.stringify({ train: "t", snapshot: { release: "snapshot-t" } }),
    );
    if (answer !== undefined) {
      await Deno.writeTextFile(
        `${root}/bin/deno`,
        `#!/usr/bin/env bash
[ "$*" = "run -A scripts/release-snapshot.ts --check-pin" ] || exit 9
[ "$(pwd -P)" = "$(cd ${JSON.stringify(root)} && pwd -P)" ] || exit 9
${answer}
`,
      );
      await Deno.chmod(`${root}/bin/deno`, 0o755);
    }
    // The tools the function uses, and no deno but the fake one.
    for (
      const tool of ["jq", "sed", "awk", "tail", "mv", "rm", "bash", "cat"]
    ) {
      if (tool === "mv" && failingMv) {
        await Deno.writeTextFile(
          `${root}/bin/mv`,
          "#!/bin/sh\necho 'mv: disk full' >&2\nexit 1\n",
        );
        await Deno.chmod(`${root}/bin/mv`, 0o755);
        continue;
      }
      const which = await new Deno.Command("which", {
        args: [tool],
        stdout: "piped",
      }).output();
      await Deno.symlink(
        new TextDecoder().decode(which.stdout).trim(),
        `${root}/bin/${tool}`,
      );
    }
    if (readOnly) await Deno.chmod(`${root}/artifacts`, 0o555);
    const out = await new Deno.Command(`${root}/bin/bash`, {
      args: [
        "-c",
        `source "$1"; keep_snapshot_pin "$2"; echo "$?|\${snapshot_dropped:-0}|\${snapshot_why:-}"; echo "\${snapshot_error:-}" >&2`,
        "bash",
        new URL("../scripts/lib/snapshot-pin.sh", import.meta.url).pathname,
        root,
      ],
      env: { PATH: `${root}/bin` },
      stdout: "piped",
      stderr: "piped",
    }).output();
    if (readOnly) await Deno.chmod(`${root}/artifacts`, 0o755);
    return {
      said: new TextDecoder().decode(out.stdout).trim(),
      stderr: new TextDecoder().decode(out.stderr),
      pins: JSON.parse(
        await Deno.readTextFile(`${root}/artifacts/pins.json`),
      ),
      leftovers: [...Deno.readDirSync(`${root}/artifacts`)].map((e) => e.name),
    };
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

Deno.test("a train drops the snapshot entry only on --check-pin's refusal, saying why", async () => {
  const entry = { release: "snapshot-t" };
  const kept = await keepPin("echo 'release-snapshot: accepted' >&2");
  assertEquals([kept.said, kept.pins.snapshot], ["0|0|", entry]);
  const refused = await keepPin(
    "echo 'snapshot pin refused: built from kernelRev a, not b' >&2\n" +
      "echo '    at a stack frame' >&2; exit 3",
  );
  assertEquals(refused.said, "0|1|built from kernelRev a, not b");
  assertEquals(refused.pins, { train: "t" });
  // No verdict: deno missing, a crash, exit 1. The pin stays, the
  // function fails, and nothing says it was dropped.
  for (
    const [why, answer] of [
      ["deno missing", undefined],
      [
        "a crash",
        "printf '\\033[31merror\\033[0m: Uncaught TypeError: boom\\n    at frame1\\n    at frame2\\n' >&2; exit 1",
      ],
    ] as const
  ) {
    const run = await keepPin(answer);
    assertEquals(run.said, "1|0|", why);
    assertEquals(run.pins.snapshot, entry, why);
    assertEquals(run.stderr.includes("--check-pin failed"), true, why);
  }
  // The error's own line names it, not its last stack frame; the whole
  // output is still on stderr.
  const crash = await keepPin(
    "printf '\\033[31merror\\033[0m: Uncaught TypeError: boom\\n    at frame1\\n    at frame2\\n' >&2; exit 1",
  );
  assertEquals(
    crash.stderr.includes(
      "--check-pin failed (exit 1): error: Uncaught TypeError: boom",
    ),
    true,
    crash.stderr,
  );
  assertEquals(crash.stderr.includes("at frame2"), true);
  // A refusal whose removal fails is not reported as dropped: it says
  // why, and leaves no temporary file.
  for (const options of [{ readOnly: true }, { failingMv: true }]) {
    const stuck = await keepPin(
      "echo 'snapshot pin refused: x' >&2; exit 3",
      options,
    );
    assertEquals(stuck.said, "1|0|", JSON.stringify(options));
    assertEquals(stuck.pins.snapshot, entry);
    assertEquals(
      stuck.stderr.includes("was refused (x) but could not be removed"),
      true,
      stuck.stderr,
    );
    assertEquals(stuck.leftovers, ["pins.json"]);
  }
  assertEquals(
    (await keepPin("echo 'snapshot pin refused: x' >&2; exit 3", {
      failingMv: true,
    })).stderr.includes("mv: disk full"),
    true,
  );
});

Deno.test("a capture does not start on an index it cannot read or without a complete set", () => {
  assertEquals(captureSetProblem("img/python@3.14.7-yurt_0:0123"), undefined);
  assertEquals(captureSetProblem(null), undefined, "the full image");
  assertEquals(
    captureSetProblem(undefined)?.includes("cannot read"),
    true,
  );
  assertEquals(
    captureSetProblem(NO_COMPLETE_SET)?.includes("no complete Python set"),
    true,
  );
});

Deno.test("a full check of a snapshot file reads it once", async () => {
  const built = {
    kernelSha256: "a".repeat(64),
    kernelRev: "r",
    sealVersion: 1,
    bootSetup: 1,
    imageSha256: "b".repeat(64),
    pythonSealSha256: null,
    pythonSet: null,
  };
  const file = new Uint8Array(
    await (await encodeSandboxSnapshot({
      version: 1,
      kernelToken: 1n,
      kernelMemory: new Uint8Array(1 << 12),
      processes: [],
      hostWaits: [],
      monotonicNs: 0n,
      realtimeOffsetNs: 0n,
      executor: { contexts: [], freeScratch: [] },
    }, built)).arrayBuffer(),
  );
  const dir = await Deno.makeTempDir();
  const open = Deno.open;
  let opens = 0;
  try {
    await Deno.writeFile(`${dir}/s.gz`, file);
    Object.defineProperty(Deno, "open", {
      value: (...args: Parameters<typeof Deno.open>) => {
        opens++;
        return open(...args);
      },
      configurable: true,
      writable: true,
    });
    const check = await checkSnapshotFile(`${dir}/s.gz`, built, {
      decode: true,
    });
    assertEquals(check, { ok: true, builtFrom: built });
    assertEquals(opens, 1);
    // With its hash too: still one read, streamed (no readFile of the
    // whole file).
    const readFile = Deno.readFile;
    Object.defineProperty(Deno, "readFile", {
      value: () => Promise.reject(new Error("read whole")),
      configurable: true,
      writable: true,
    });
    try {
      const sha256 = await sha256Hex(file);
      opens = 0;
      assertEquals(
        await checkSnapshotFile(`${dir}/s.gz`, built, { sha256 }),
        { ok: true, builtFrom: built },
      );
      assertEquals(opens, 1);
      // Both at once would queue the file between the two: refused.
      await assertRejects(
        () =>
          checkSnapshotFile(
            `${dir}/s.gz`,
            built,
            { sha256, decode: true } as unknown as { sha256: string },
          ),
        Error,
        "not both",
      );
      const wrong = await checkSnapshotFile(`${dir}/s.gz`, built, {
        sha256: "0".repeat(64),
      });
      assertEquals(!wrong.ok && wrong.problem.includes("its sha256 is"), true);
    } finally {
      Object.defineProperty(Deno, "readFile", {
        value: readFile,
        configurable: true,
        writable: true,
      });
    }
  } finally {
    Object.defineProperty(Deno, "open", {
      value: open,
      configurable: true,
      writable: true,
    });
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a snapshot release's notes name everything a restore checks", () => {
  const builtFrom = {
    kernelSha256: "k".repeat(64),
    kernelRev: "rev0123",
    sealVersion: 1,
    bootSetup: 2,
    imageSha256: "i".repeat(64),
    pythonSealSha256: "p".repeat(64),
    pythonSet: "img/python@3.14.7-yurt_0:0123456789abcdef",
  };
  const notes = releaseNotes("playground-t", {
    releaseRepo: "YurtOS/yurt-playground",
    release: "snapshot-playground-t",
    format: 3,
    sha256: "s".repeat(64),
    size: 10,
    parts: ["a".repeat(64)],
    builtFrom,
  });
  for (const value of Object.values(builtFrom)) {
    assertEquals(notes.includes(`\`${value}\``), true, String(value));
  }
  assertEquals(notes.includes("sealable CPython (pythonSeal) sha256"), true);
  assertEquals(notes.includes("Python set installed"), true);
  assertEquals(notes.includes("Header format 3"), true);
});
