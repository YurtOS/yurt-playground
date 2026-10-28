import { assertEquals } from "@std/assert";
import {
  kernelCheckoutProblem,
  releaseProblems,
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
    /YURT_INSTALL_SNAPSHOT:-\}" == 1 \]\]; then[^]*download "\$tag" "\$repo" 'sandbox\.seal\.gz/
      .test(script),
    true,
    "the snapshot is fetched through download(), behind YURT_INSTALL_SNAPSHOT=1",
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

Deno.test("a train keeps the snapshot pin only when every part of its identity is unchanged", async () => {
  const { snapshotIdentity } = await import("../src/sandbox_snapshot.ts");
  const pins = JSON.parse(
    await Deno.readTextFile(new URL("../artifacts/pins.json", import.meta.url)),
  );
  const script = await Deno.readTextFile(
    new URL("../scripts/release-playground.sh", import.meta.url),
  );
  for (const key of Object.keys(snapshotIdentity(pins))) {
    assertEquals(
      new RegExp(`\\.${key} == \\$`).test(script),
      true,
      `release-playground.sh compares builtFrom.${key}`,
    );
  }
});

Deno.test("a snapshot is released only from the pinned kernel rev, with a clean tree", async () => {
  const dir = await Deno.makeTempDir();
  const git = async (...args: string[]) => {
    const out = await new Deno.Command("git", {
      args: ["-C", dir, ...args],
      stdout: "piped",
      stderr: "null",
      // Not a hook's GIT_DIR or GIT_INDEX_FILE: this checkout's own.
      clearEnv: true,
      env: {
        PATH: Deno.env.get("PATH") ?? "",
        HOME: Deno.env.get("HOME") ?? "",
      },
    }).output();
    return new TextDecoder().decode(out.stdout).trim();
  };
  try {
    await git("init", "-q");
    await Deno.writeTextFile(`${dir}/a`, "1");
    await Deno.writeTextFile(`${dir}/deno.lock`, "{}");
    await git("add", "a", "deno.lock");
    await git(
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "commit",
      "-q",
      "-m",
      "a",
    );
    const head = await git("rev-parse", "HEAD");
    assertEquals(await kernelCheckoutProblem(dir, head), undefined);
    // The page's bundle writes the checkout's lockfile; that is no change.
    await Deno.writeTextFile(`${dir}/deno.lock`, '{"npm":{}}');
    assertEquals(await kernelCheckoutProblem(dir, head), undefined);
    assertEquals(
      (await kernelCheckoutProblem(dir, "0".repeat(40)))?.includes(
        `is at ${head}, not the pinned ${"0".repeat(40)}`,
      ),
      true,
    );
    await Deno.writeTextFile(`${dir}/a`, "2");
    assertEquals(
      (await kernelCheckoutProblem(dir, head))?.includes(
        "uncommitted changes",
      ),
      true,
    );
    assertEquals(
      (await kernelCheckoutProblem(`${dir}/nope`, head))?.startsWith(
        "cannot read the kernel checkout",
      ),
      true,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
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
