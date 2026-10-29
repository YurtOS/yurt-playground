import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import type { Catalog } from "../src/packages.ts";
import { parsePins } from "../src/pins.ts";
import {
  IndexUnreadable,
  liveAnswers,
  liveLayerKey,
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

Deno.test("an index that cannot be had keeps its cause and is said, not silent", async () => {
  const cause = new SyntaxError("index.json is not JSON");
  await assertRejects(
    async () => {
      try {
        await liveLayerKey(
          "img",
          ["python"],
          1000,
          () => Promise.reject(cause),
        );
      } catch (error) {
        assertEquals((error as Error).cause, cause);
        throw error;
      }
    },
    IndexUnreadable,
  );
  const said: unknown[][] = [];
  const info = console.info;
  console.info = (...args: unknown[]) => said.push(args);
  try {
    assertEquals(
      await livePythonSet(
        { set: ["python"], image: "img" },
        1000,
        () => Promise.reject(cause),
      ),
      undefined,
    );
  } finally {
    console.info = info;
  }
  assertEquals(said.length, 1);
  assertEquals((said[0][1] as Error).cause, cause);
});

Deno.test("one boot's two questions to the live index come from one read of it", async () => {
  let loads = 0;
  const catalog = { metadata: new Map() } as unknown as Catalog;
  const live = liveAnswers({ set: ["python"], image: "img" }, () => {
    loads++;
    return Promise.resolve(catalog);
  });
  assertEquals(await live.pythonSet(), NO_COMPLETE_SET);
  assertEquals(await live.layerKey(), undefined);
  assertEquals(loads, 1);
  // A page that installs no Python asks nothing.
  const none = liveAnswers(undefined, () => {
    loads++;
    return Promise.resolve(catalog);
  });
  assertEquals(await none.pythonSet(), null);
  assertEquals(await none.layerKey(), undefined);
  assertEquals(loads, 1);
});

Deno.test("a boot keeps its read of the live index, a failed one included, until the install's question is answered", async () => {
  const catalog = { metadata: new Map() } as unknown as Catalog;
  const reads: ("fail" | "ok")[] = ["fail", "ok", "ok"];
  let loads = 0;
  const live = liveAnswers({ set: ["python"], image: "img" }, () => {
    const result = reads[loads++];
    return result === "fail"
      ? Promise.reject(new TypeError("network down"))
      : Promise.resolve(catalog);
  });
  const info = console.info;
  console.info = () => {};
  try {
    // The snapshot's question fails; the install's, in the same boot,
    // waits no second time on the index.
    assertEquals(await live.pythonSet(), undefined);
    await assertRejects(() => live.layerKey(), IndexUnreadable);
    assertEquals(loads, 1);
    // Answered: a later question (a retry on this sandbox) reads again.
    assertEquals(await live.layerKey(), undefined);
    assertEquals(loads, 2);
    assertEquals(await live.pythonSet(), NO_COMPLETE_SET);
    assertEquals(loads, 3);
  } finally {
    console.info = info;
  }
});

Deno.test("each boot makes its own live answers (coordinator_worker's begin)", async () => {
  // The worker cannot run here: its begin() is checked as written.
  const worker = await Deno.readTextFile(
    new URL("../src/coordinator_worker.ts", import.meta.url),
  );
  const begin = worker.match(/const begin = async \(\) => \{\n\s*(.*)\n/);
  assertEquals(begin?.[1], "live = liveAnswers(msg.python);");
  assertEquals(worker.includes("livePythonSet: () => live.pythonSet(),"), true);
  assertEquals(worker.includes("liveKey: () => live.layerKey(),"), true);
});
