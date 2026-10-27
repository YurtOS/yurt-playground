import { assertEquals, assertThrows } from "@std/assert";
import { parsePins, PinResolutionError } from "../src/pins.ts";
import {
  PYTHON_LABEL,
  pythonInstallRequest,
  pythonInstallState,
} from "../src/python_install.ts";

const sha = (c: string) => c.repeat(64);
const artifact = {
  repo: "YurtOS/yurt-ports",
  rev: "r",
  build: "b",
  path: "p",
  sha256: sha("a"),
};
const base = { kernelWasm: artifact, image: artifact };
const packages = {
  python: { version: "3.14.7", build: "yurt_0", sha256: sha("b"), size: 11 },
  numpy: { version: "2.5.0", build: "yurt_0", sha256: sha("c"), size: 4 },
};

Deno.test("pins without the slim image or packages parse as before", () => {
  const pins = parsePins(base);
  assertEquals(pins.browserImage, undefined);
  assertEquals(pins.packages, undefined);
  assertEquals(pythonInstallRequest(pins), undefined);
  assertEquals(pythonInstallState(pins).available, false);
  assertEquals(pythonInstallState(undefined).available, false);
});

Deno.test("the slim image and the Python packages: exact builds, Python first", () => {
  const pins = parsePins({
    ...base,
    browserImage: { ...artifact, sha256: sha("D") },
    packages,
    pythonPackages: ["python", "numpy"],
  });
  assertEquals(pins.browserImage?.sha256, sha("d"));
  assertEquals(pythonInstallRequest(pins), {
    label: PYTHON_LABEL,
    releases: [
      { name: "python", ...packages.python },
      { name: "numpy", ...packages.numpy },
    ],
  });
  assertEquals(pythonInstallState(pins), { available: true, reason: "" });
});

Deno.test("a package pin pkg could not install exactly is refused", () => {
  for (
    const bad of [
      // `pkg install python@3.14.7-1` reads `-1` as a pre-release.
      { ...packages.python, build: "1" },
      { ...packages.python, version: "3.14" },
      { ...packages.python, sha256: "x" },
      { ...packages.python, size: 0 },
    ]
  ) {
    assertThrows(
      () => parsePins({ ...base, packages: { python: bad } }),
      PinResolutionError,
    );
  }
  assertThrows(
    () => parsePins({ ...base, packages: { "../x": packages.python } }),
    PinResolutionError,
  );
  // pythonPackages may name only pinned packages.
  assertThrows(
    () => parsePins({ ...base, packages, pythonPackages: ["python", "pip"] }),
    PinResolutionError,
  );
  assertThrows(
    () => parsePins({ ...base, packages, pythonPackages: [] }),
    PinResolutionError,
  );
});
