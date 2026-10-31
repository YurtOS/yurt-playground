import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  type SnapshotProbe,
  verifySnapshotPins,
  verifySnapshotProbe,
} from "../scripts/verify-snapshots.ts";

type Pinned = {
  contents: { packages: { name: string; version: string; build: string }[] };
  builtFrom: { pythonSet: string | null };
  memoryBytes: number;
  size: number;
  restorePeakMiB?: number;
};

const IMAGE = "e".repeat(64);

function release(name: string, version: string) {
  return { name, version, build: "yurt_0" };
}

/** A snapshot pin of the shape release-snapshot.ts writes. */
function pin(
  tag: string,
  names: [string, string][],
  pythonSet: string | null,
  memoryBytes: number,
  size: number,
  restorePeakMiB: number,
): Record<string, unknown> {
  return {
    releaseRepo: "YurtOS/yurt-playground",
    release: tag,
    format: 3,
    sha256: "a".repeat(64),
    size,
    parts: ["b".repeat(64)],
    builtFrom: {
      kernelSha256: "d".repeat(64),
      kernelRev: "r",
      sealVersion: 1,
      bootSetup: 2,
      imageSha256: IMAGE,
      pythonSealSha256: pythonSet === null ? null : "f".repeat(64),
      pythonSet,
    },
    memoryBytes,
    restorePeakMiB,
    contents: {
      packages: [
        release("ca-certificates", "2026.9.25"),
        release("git", "2.55.0"),
        ...names.map(([name, version]) => release(name, version)),
      ],
      remark: "BusyBox shell",
    },
  };
}

/** Three kinds as a train pins them: desktop > tablet > phone. */
function fixture(): Record<string, Record<string, unknown>> {
  return {
    snapshot: pin(
      "snapshot-t",
      [["jupyter-kernel", "0.0.1"], ["numpy", "2.5.0"], ["python", "3.14.7"], [
        "pyzmq",
        "26.4.0",
      ]],
      `${IMAGE}/jupyter-kernel@0.0.1-yurt_0:1+numpy@2.5.0-yurt_0:2+python@3.14.7-yurt_0:3+pyzmq@26.4.0-yurt_0:4`,
      546_701_312,
      130_826_562,
      2459,
    ),
    tabletSnapshot: pin(
      "snapshot-tablet-t",
      [["python", "3.14.7"]],
      `${IMAGE}/python@3.14.7-yurt_0:3`,
      399_245_312,
      94_664_921,
      1267,
    ),
    phoneSnapshot: pin(
      "snapshot-phone-t",
      [],
      null,
      142_671_872,
      31_212_448,
      630,
    ),
  };
}

function problemsWith(key: string, edit: (pin: Pinned) => void): string[] {
  const pins = fixture();
  edit(pins[key] as unknown as Pinned);
  return verifySnapshotPins(pins);
}

Deno.test("the committed snapshot pins hold what their kinds are for, largest first", async () => {
  // complete: false -- mid-train, a commit has some pins dropped or not
  // yet measured (scripts/verify-snapshots.ts checks a finished train).
  const pins = JSON.parse(
    await Deno.readTextFile(new URL("../artifacts/pins.json", import.meta.url)),
  );
  assertEquals(verifySnapshotPins(pins, { complete: false }), []);
});

Deno.test("a train's three snapshots pass", () => {
  assertEquals(verifySnapshotPins(fixture()), []);
});

Deno.test("a phone snapshot with Python in it is refused", () => {
  const problems = problemsWith("phoneSnapshot", (pin) => {
    pin.contents.packages.push(release("python", "3.14.7"));
  });
  assertEquals(problems, ["phone: holds python"]);
});

Deno.test("a phone snapshot built with a Python set is refused", () => {
  const problems = problemsWith("phoneSnapshot", (pin) => {
    pin.builtFrom.pythonSet = `${IMAGE}/python@3.14.7-yurt_0:3`;
  });
  assertStringIncludes(problems.join("\n"), "phone: built with a Python set");
});

Deno.test("a desktop snapshot without numpy is refused", () => {
  const problems = problemsWith("snapshot", (pin) => {
    pin.contents.packages = pin.contents.packages.filter((p) =>
      p.name !== "numpy"
    );
  });
  assertEquals(problems, ["desktop: lacks numpy"]);
});

Deno.test("a tablet snapshot with Jupyter in it is refused", () => {
  const problems = problemsWith("tabletSnapshot", (pin) => {
    pin.contents.packages.push(release("jupyter-kernel", "0.0.1"));
  });
  assertEquals(problems, ["tablet: holds jupyter-kernel"]);
});

Deno.test("a tablet snapshot whose Python set key holds numpy is refused", () => {
  const problems = problemsWith("tabletSnapshot", (pin) => {
    pin.builtFrom.pythonSet =
      `${IMAGE}/numpy@2.5.0-yurt_0:2+python@3.14.7-yurt_0:3`;
  });
  assertEquals(problems, ["tablet: its Python set key holds numpy"]);
});

Deno.test("a phone snapshot as large as the tablet's is refused", () => {
  const problems = problemsWith("phoneSnapshot", (pin) => {
    pin.memoryBytes = 399_245_312;
  });
  assertEquals(problems, [
    "memoryBytes: tablet (399245312) is not larger than phone (399245312)",
  ]);
});

Deno.test("the order holds across a kind that is not pinned", () => {
  const pins = fixture();
  delete pins.tabletSnapshot;
  (pins.phoneSnapshot as unknown as Pinned).restorePeakMiB = 3000;
  assertEquals(verifySnapshotPins(pins, { complete: false }), [
    "restorePeakMiB: desktop (2459) is not larger than phone (3000)",
  ]);
});

Deno.test("a missing or unmeasured snapshot is refused only when the train is complete", () => {
  const pins = fixture();
  delete pins.tabletSnapshot;
  delete (pins.phoneSnapshot as unknown as Pinned).restorePeakMiB;
  assertEquals(verifySnapshotPins(pins), [
    "tablet: no tabletSnapshot pin",
    "phone: the pin records no restorePeakMiB (scripts/measure-boot.ts)",
  ]);
  assertEquals(verifySnapshotPins(pins, { complete: false }), []);
});

Deno.test("a live probe is held to its kind", () => {
  const probe: SnapshotProbe = {
    kind: "phone",
    restored: true,
    restoredBytes: 1,
    processes: [],
    python: false,
    imports: { numpy: false, zmq: false },
    notebook: false,
    memTotalKiB: null,
    df: "",
  };
  assertEquals(verifySnapshotProbe(probe), []);
  assertEquals(verifySnapshotProbe({ ...probe, python: true }), [
    "phone: python3 is on the PATH",
  ]);
  assertEquals(
    verifySnapshotProbe({
      ...probe,
      kind: "desktop",
      python: true,
      imports: { numpy: true, zmq: false },
      notebook: true,
    }),
    ["desktop: import zmq fails"],
  );
  assertEquals(verifySnapshotProbe({ ...probe, restored: false }), [
    "phone: not restored from its snapshot",
  ]);
});
