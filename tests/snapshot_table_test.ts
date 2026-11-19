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
    tabletSnapshot: {
      releaseRepo: "YurtOS/yurt-playground",
      release: "snapshot-tablet-t",
      format: 3,
      sha256: "a".repeat(64),
      size: 31_192_802,
      builtFrom: {
        kernelSha256: "d".repeat(64),
        kernelRev: "r",
        sealVersion: 1,
        bootSetup: 2,
        imageSha256: "e".repeat(64),
        pythonSealSha256: null,
        pythonSet: "e/python@3.14.7-yurt_0:1",
      },
      memoryBytes: 142_671_872,
      restorePeakMiB: 400,
      contents: {
        packages: [],
        remark: "BusyBox shell, Python 3.14.7; no Jupyter",
      },
    },
  });
  assertStringIncludes(
    table,
    "| tablet | home page on a tablet (iPad) and phone (iPhone): `?platform=tablet`, `?platform=phone` | `snapshot-tablet-t` | 31.2 MB in 2 parts | 136.1 MiB | 400 MiB | BusyBox shell, Python 3.14.7; no Jupyter |",
  );
  assertStringIncludes(
    table,
    "| desktop | desktop browser (Mac, PC): `?platform=desktop`; the Notebook and JupyterLab on a tablet (iPad), and on a phone with `?memory=1g` | not pinned",
  );
  assertStringIncludes(
    table,
    "| go | desktop browser that chose Go: `?platform=desktop&env=go` | not pinned",
  );
});
