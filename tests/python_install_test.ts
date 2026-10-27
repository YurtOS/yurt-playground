import { assertEquals, assertThrows } from "@std/assert";
import { parsePins } from "../src/pins.ts";
import {
  PYTHON_LABEL,
  PYTHON_SET,
  pythonInstallRequest,
  pythonInstallState,
} from "../src/python_install.ts";

const artifact = {
  repo: "YurtOS/yurt-ports",
  rev: "r",
  build: "b",
  path: "p",
  sha256: "a".repeat(64),
};
const base = { kernelWasm: artifact, image: artifact };

Deno.test("pins without a slim image: nothing to install, as before", () => {
  const pins = parsePins(base);
  assertEquals(pins.browserImage, undefined);
  assertEquals(pythonInstallRequest(pins), undefined);
  assertEquals(pythonInstallState(pins).available, false);
  assertEquals(pythonInstallState(undefined).available, false);
});

Deno.test("a slim image installs the Python set, Python first, from the live index", () => {
  const pins = parsePins({
    ...base,
    browserImage: { ...artifact, sha256: "D".repeat(64) },
  });
  assertEquals(pins.browserImage?.sha256, "d".repeat(64));
  assertEquals(pythonInstallRequest(pins), {
    label: PYTHON_LABEL,
    set: ["python", "numpy", "pyzmq", "jupyter-kernel"],
    // A stored install is kept per slim image (src/python_layer.ts).
    image: "d".repeat(64),
  });
  assertEquals(PYTHON_SET[0], "python");
  assertEquals(pythonInstallState(pins), { available: true, reason: "" });
});

Deno.test("a slim image pin is an artifact pin like the others", () => {
  assertThrows(() =>
    parsePins({ ...base, browserImage: { ...artifact, sha256: "" } })
  );
});
