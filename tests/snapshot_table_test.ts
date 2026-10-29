import { assertEquals, assertStringIncludes } from "@std/assert";
import { snapshotTable, withTable } from "../scripts/snapshot-table.ts";

Deno.test("the README's snapshot table is the one artifacts/pins.json makes", async () => {
  const pins = JSON.parse(
    await Deno.readTextFile(new URL("../artifacts/pins.json", import.meta.url)),
  );
  const readme = await Deno.readTextFile(
    new URL("../README.md", import.meta.url),
  );
  assertEquals(
    withTable(readme, snapshotTable(pins)),
    readme,
    "stale: run deno run -A scripts/snapshot-table.ts",
  );
});

Deno.test("the snapshot table names each kind, and says when one is not pinned", () => {
  const table = snapshotTable({
    train: "t",
    phoneSnapshot: {
      releaseRepo: "YurtOS/yurt-playground",
      release: "snapshot-phone-t",
      format: 3,
      sha256: "a".repeat(64),
      size: 31_192_802,
      parts: ["b".repeat(64), "c".repeat(64)],
      builtFrom: {
        kernelSha256: "d".repeat(64),
        kernelRev: "r",
        sealVersion: 1,
        bootSetup: 2,
        imageSha256: "e".repeat(64),
        pythonSealSha256: null,
        pythonSet: null,
      },
      memoryBytes: 142_671_872,
      restorePeakMiB: 400,
      contents: {
        packages: [],
        remark: "BusyBox shell; no Python, no Jupyter",
      },
    },
  });
  assertStringIncludes(
    table,
    "| phone | phone (iPhone): `?platform=phone` | `snapshot-phone-t` | 31.2 MB in 2 parts | 136.1 MiB | 400 MiB | BusyBox shell; no Python, no Jupyter |",
  );
  assertStringIncludes(
    table,
    "| desktop | desktop browser (Mac, PC): `?platform=desktop` | not pinned",
  );
  assertStringIncludes(
    table,
    "| tablet | tablet (iPad): `?platform=tablet` | not pinned",
  );
});
