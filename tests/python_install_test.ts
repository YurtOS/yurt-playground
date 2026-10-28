import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import type { Catalog } from "../src/packages.ts";
import { parsePins } from "../src/pins.ts";
import {
  IndexUnreadable,
  livePythonSet,
  NO_COMPLETE_SET,
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

Deno.test("only a set the index does not offer is 'no complete set'; a crash is thrown", async () => {
  const catalog = (versions: unknown[]) =>
    ({
      metadata: new Map([["python", { file: { versions } }]]),
    }) as unknown as Catalog;
  const request = { set: ["python"], image: "img" };
  // Answered, without the set.
  assertEquals(
    await livePythonSet(request, 1000, () => Promise.resolve(catalog([]))),
    NO_COMPLETE_SET,
  );
  // Not downloaded: no verdict.
  assertEquals(
    await livePythonSet(
      request,
      1000,
      () => Promise.reject(new IndexUnreadable("down")),
    ),
    undefined,
  );
  // Downloaded, but not an index the page can parse: no answer either.
  assertEquals(
    await livePythonSet(
      request,
      1000,
      () => Promise.reject(new SyntaxError("index.json is not JSON")),
    ),
    undefined,
  );
  // A catalog the code cannot read is a crash, not an answer.
  await assertRejects(
    () =>
      livePythonSet(
        request,
        1000,
        () => Promise.resolve({ metadata: null } as unknown as Catalog),
      ),
    TypeError,
  );
});

Deno.test("a pythonSeal entry of another shape is left out of the pins, not a failed boot", () => {
  for (const pythonSeal of [{ sha256: 7 }, "seal", null, { release: "r" }]) {
    const pins = parsePins({ ...base, pythonSeal });
    assertEquals(pins.pythonSeal, undefined, JSON.stringify(pythonSeal));
  }
  assertEquals(
    parsePins({ ...base, pythonSeal: { sha256: "AB".repeat(32) } }).pythonSeal,
    { sha256: "ab".repeat(32) },
  );
});
