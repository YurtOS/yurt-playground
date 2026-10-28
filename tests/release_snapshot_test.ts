import { assertEquals } from "@std/assert";
import { releaseProblems } from "../scripts/release-snapshot.ts";

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
