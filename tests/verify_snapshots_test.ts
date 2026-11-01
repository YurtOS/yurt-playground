import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  compiledPackages,
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

/** Four kinds as a train pins them: desktop > tablet > phone, go > phone. */
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
    goSnapshot: pin(
      "snapshot-go-t",
      [["go", "1.28.0-devel"]],
      `${IMAGE}/go@1.28.0-devel-yurt_1:5`,
      420_000_000,
      60_000_000,
      1300,
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

Deno.test("a train's four snapshots pass", () => {
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

Deno.test("a Go snapshot with Python in it, or without go, is refused", () => {
  assertEquals(
    problemsWith("goSnapshot", (pin) => {
      pin.contents.packages.push(release("python", "3.14.7"));
    }),
    ["go: holds python"],
  );
  assertEquals(
    problemsWith("goSnapshot", (pin) => {
      pin.contents.packages = pin.contents.packages.filter((p) =>
        p.name !== "go"
      );
    }),
    ["go: lacks go"],
  );
  assertEquals(
    problemsWith("goSnapshot", (pin) => {
      pin.builtFrom.pythonSet = `${IMAGE}/python@3.14.7-yurt_0:3`;
    }),
    [
      "go: its Python set key lacks go",
      "go: its Python set key holds python",
    ],
  );
  assertStringIncludes(
    problemsWith("goSnapshot", (pin) => {
      pin.builtFrom.pythonSet = null;
    }).join("\n"),
    "go: built with no Python set",
  );
});

Deno.test("the desktop's Python snapshot with go in it is refused", () => {
  assertEquals(
    problemsWith("snapshot", (pin) => {
      pin.contents.packages.push(release("go", "1.28.0-devel"));
    }),
    ["desktop: holds go"],
  );
});

Deno.test("a Go snapshot is held to be larger than the phone's, not to the desktop's order", () => {
  // Larger or smaller than the desktop's Python one: either is fine.
  assertEquals(
    problemsWith("goSnapshot", (pin) => {
      pin.memoryBytes = 600_000_000;
      pin.restorePeakMiB = 2600;
      pin.size = 140_000_000;
    }),
    [],
  );
  assertEquals(
    problemsWith("goSnapshot", (pin) => {
      pin.memoryBytes = 142_671_872;
    }),
    ["memoryBytes: go (142671872) is not larger than phone (142671872)"],
  );
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
  delete pins.goSnapshot;
  (pins.phoneSnapshot as unknown as Pinned).restorePeakMiB = 3000;
  assertEquals(verifySnapshotPins(pins, { complete: false }), [
    "restorePeakMiB: desktop (2459) is not larger than phone (3000)",
  ]);
});

Deno.test("a missing or unmeasured snapshot is refused only when the train is complete", () => {
  const pins = fixture();
  delete pins.tabletSnapshot;
  delete (pins.phoneSnapshot as unknown as Pinned).restorePeakMiB;
  delete pins.goSnapshot;
  assertEquals(verifySnapshotPins(pins), [
    "tablet: no tabletSnapshot pin",
    "phone: the pin records no restorePeakMiB (scripts/measure-boot.ts)",
    "go: no goSnapshot pin",
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
    go: false,
    goCompiled: null,
    goBuildSeconds: null,
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

Deno.test("a live probe of Go's snapshot needs go and a warm build cache", () => {
  const probe: SnapshotProbe = {
    kind: "go",
    restored: true,
    restoredBytes: 1,
    processes: [],
    python: false,
    go: true,
    goCompiled: [],
    goBuildSeconds: 20,
    imports: { numpy: false, zmq: false },
    notebook: false,
    memTotalKiB: null,
    df: "",
  };
  assertEquals(verifySnapshotProbe(probe), []);
  assertEquals(verifySnapshotProbe({ ...probe, go: false, goCompiled: null }), [
    "go: go is not on the PATH",
  ]);
  assertEquals(
    verifySnapshotProbe({ ...probe, goCompiled: ["fmt", "os"] }),
    [
      "go: a first go build compiled the standard library's fmt, os (the build cache is cold)",
    ],
  );
  assertEquals(
    verifySnapshotProbe({
      ...probe,
      kind: "desktop",
      python: true,
      imports: { numpy: true, zmq: true },
      notebook: true,
    }),
    ["desktop: go is on the PATH"],
  );
});

Deno.test("compiledPackages reads the packages go build -x compiled", () => {
  const log = [
    "WORK=/tmp/go-build1",
    "mkdir -p $WORK/b001/",
    '/usr/lib/go/pkg/tool/linux_wasm32/compile -o $WORK/b001/_pkg_.a -trimpath "$WORK/b001=>" -p main -lang=go1.28 -complete -buildid x/x -goversion go1.28 -c=4 -nolocalimports -importcfg $WORK/b001/importcfg -pack ./go-probe.go',
    "/usr/lib/go/pkg/tool/linux_wasm32/link -o $WORK/b001/exe/a.out",
  ].join("\n");
  assertEquals(compiledPackages(log), []);
  assertEquals(
    compiledPackages(
      `${log}\n/usr/lib/go/pkg/tool/linux_wasm32/compile -o $WORK/b014/_pkg_.a -p strings -std -complete\n` +
        "/usr/lib/go/pkg/tool/linux_wasm32/compile -o $WORK/b002/_pkg_.a -p fmt -std",
    ),
    ["strings", "fmt"],
  );
});
