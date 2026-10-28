import { assertEquals } from "@std/assert";
import {
  checkoutProblem,
  releaseProblems,
  snapshotPinProblem,
} from "../scripts/release-snapshot.ts";
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
  const live = (answer: string | null | Error) => () =>
    answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
  const check = (snapshot: unknown, answer: string | null | Error) =>
    snapshotPinProblem({ ...pins, snapshot }, live(answer));
  assertEquals(await check(entry, set), undefined);
  // The index cannot be read: kept, as the page restores it then too.
  assertEquals(await check(entry, new Error("offline")), undefined);
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
  // release-playground.sh drops the entry on a refusal, saying why.
  const script = await Deno.readTextFile(
    new URL("../scripts/release-playground.sh", import.meta.url),
  );
  assertEquals(
    /if ! snapshot_why=\$\(cd "\$root" && deno run -A scripts\/release-snapshot\.ts --check-pin 2>&1\); then\s+jq 'del\(\.snapshot\)'/
      .test(script),
    true,
  );
  assertEquals(script.includes(".builtFrom"), false);
});

Deno.test("a snapshot is released only from the pinned kernel rev and a pushed playground head, both clean", async () => {
  const dir = await Deno.makeTempDir();
  const remote = await Deno.makeTempDir();
  const git = async (cwd: string, ...args: string[]) => {
    const out = await new Deno.Command("git", {
      args: ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...args],
      stdout: "piped",
      stderr: "null",
      // Not a hook's GIT_DIR or GIT_INDEX_FILE.
      clearEnv: true,
      env: {
        PATH: Deno.env.get("PATH") ?? "",
        HOME: Deno.env.get("HOME") ?? "",
      },
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
    await git(remote, "init", "-q", "--bare");
    await git(dir, "remote", "add", "origin", remote);
    await git(dir, "push", "-q", "-u", "origin", "main");
    assertEquals(await checkoutProblem(dir, "upstream"), undefined);
    // Someone pushed since the last fetch: the remote's head counts.
    const other = await Deno.makeTempDir();
    await git(other, "clone", "-q", remote, ".");
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
