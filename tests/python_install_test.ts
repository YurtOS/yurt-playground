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
  sealVerification,
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
  // A tablet's restore asks about its snapshot's python, as it installs
  // none itself.
  assertEquals(
    begin?.[1],
    "live = liveAnswers(msg.python ?? msg.snapshotPython);",
  );
  // ...and ends its read once startSandbox has returned.
  assertEquals(
    /const started = await startSandbox\(\{[^]*?\n {4}\}\);\n(?:\s*\/\/.*\n)*\s*live\.finish\(\);/
      .test(worker),
    true,
  );
  assertEquals(worker.includes("livePythonSet: () => live.pythonSet(),"), true);
  assertEquals(worker.includes("liveKey: () => live.layerKey(),"), true);
});

Deno.test("a boot with no install's question drops its read when it is over", async () => {
  let loads = 0;
  const live = liveAnswers({ set: ["python"], image: "img" }, () => {
    loads++;
    return Promise.reject(new TypeError("network down"));
  });
  const info = console.info;
  console.info = () => {};
  try {
    // A restore asks once; the boot ends with no install's question.
    assertEquals(await live.pythonSet(), undefined);
    live.finish();
    // A later Install on this sandbox reads the index again.
    await assertRejects(() => live.layerKey(), IndexUnreadable);
    assertEquals(loads, 2);
  } finally {
    console.info = info;
  }
});

/** A catalog with the whole Python set at each of `builds`. */
function setCatalog(builds: number[]): Catalog {
  const versions: Record<string, string> = {
    python: "3.14.7",
    numpy: "2.5.0",
    pyzmq: "26.4.0",
    "jupyter-kernel": "0.0.1",
  };
  return {
    metadata: new Map(
      Object.entries(versions).map(([name, version]) => [name, {
        bytes: new Uint8Array(),
        file: {
          name,
          versions: builds.map((n) => ({
            version,
            build: `yurt_${n}`,
            url: `artifacts/${name}/${name}-${version}-yurt_${n}.yurtpkg`,
            sha256: `${name}${n}`.padEnd(64, "0"),
            size: 1,
            depends: [],
            yanked: false,
          })),
        },
      }]),
    ),
  } as unknown as Catalog;
}

Deno.test("a slim image that ships python names it, and its set is the one at that python's build", async () => {
  const slim = { ...artifact, sha256: "d".repeat(64) };
  const pins = parsePins({
    ...base,
    browserImage: { ...slim, python: { version: "3.14.7", build: "yurt_0" } },
  });
  const request = pythonInstallRequest(pins)!;
  assertEquals(request.installed, [
    { name: "python", version: "3.14.7", build: "yurt_0" },
  ]);
  // python at yurt_0 with yurt_0's set still live: that set, not yurt_1's
  // -- for the snapshot and the stored layer as for the install.
  const both = () => Promise.resolve(setCatalog([0, 1]));
  const key = await livePythonSet(request, 1000, both);
  assertEquals(key?.includes("python@3.14.7-yurt_0"), true, key ?? "");
  assertEquals(key?.includes("yurt_1"), false, key ?? "");
  // Only yurt_1 live: no set this image can take.
  assertEquals(
    await livePythonSet(request, 1000, () => Promise.resolve(setCatalog([1]))),
    NO_COMPLETE_SET,
  );
  // No python in the image: the newest set, as before.
  const today = pythonInstallRequest(
    parsePins({ ...base, browserImage: slim }),
  )!;
  assertEquals("installed" in today, false);
  assertEquals(
    (await livePythonSet(today, 1000, both))?.includes("python@3.14.7-yurt_1"),
    true,
  );
});

Deno.test("a slim image's python entry of another shape is a broken pin", () => {
  for (
    const python of [
      "3.14.7-yurt_0",
      { version: "3.14.7" },
      { version: "", build: "yurt_0" },
      { version: "3.14.7", build: "0" },
    ]
  ) {
    assertThrows(
      () => parsePins({ ...base, browserImage: { ...artifact, python } }),
      Error,
      "browserImage.python",
      JSON.stringify(python),
    );
  }
});

Deno.test("the Suspend/Resume set verifies only what pkg fetches, and takes an image's own python's stdlib from the image", () => {
  const python = { name: "python", version: "3.14.7", build: "yurt_0" };
  const seal = { name: "python-seal", version: "3.14.7", build: "yurt_0" };
  // Today's slim image: no python; both are verified, the stdlib comes
  // from the python archive.
  assertEquals(sealVerification([python, seal], []), {
    verify: [python, seal],
    stdlibFromImage: false,
  });
  assertEquals(
    sealVerification([python, seal], [
      { name: "git", version: "2.55.0", build: "yurt_0" },
    ]).verify,
    [python, seal],
  );
  // The next slim image: its python is the set's (resolveSet pinned it);
  // pkg reuses it and fetches only the seal.
  assertEquals(sealVerification([python, seal], [python]), {
    verify: [seal],
    stdlibFromImage: true,
  });
  // An image with another python cannot run this set.
  assertThrows(
    () => sealVerification([python, seal], [{ ...python, build: "yurt_1" }]),
    Error,
    "python 3.14.7-yurt_1 installed, not the set's 3.14.7-yurt_0",
  );
  // An installed seal, even at the set's release, would go unverified
  // while the kernel reads its archive: refused, with or without python.
  for (const installed of [[seal], [python, seal]]) {
    assertThrows(
      () => sealVerification([python, seal], installed),
      Error,
      "the slim image has python-seal installed: this kernel reads its archive",
    );
  }
});

Deno.test("the Suspend/Resume set is pinned to the slim image's python too", async () => {
  const source = await Deno.readTextFile(
    new URL("../src/notebook_kernel_worker.ts", import.meta.url),
  );
  // A scoped source check (the worker is not loadable in a test): the set
  // is resolved with the pins' installed python, and verified through
  // sealVerification against the verifying sandbox's own list.
  assertEquals(
    /resolveSet\(catalog, \[\.\.\.PYTHON_SET, SEAL_PACKAGE\], installed\)/
      .test(source),
    true,
  );
  assertEquals(
    source.includes(
      "const installed = pythonInstallRequest(pins)?.installed ?? [];",
    ),
    true,
  );
  assertEquals(
    /sealVerification\(\s*\[set\.python, set\.seal\],\s*await installedReleases\(session\.files\) \?\? \[\],/
      .test(source),
    true,
  );
  assertEquals(source.includes("releases: verify,"), true);
});

Deno.test("the Suspend/Resume set refuses an image that disagrees with its pins about python", () => {
  const python = { name: "python", version: "3.14.7", build: "yurt_0" };
  const seal = { name: "python-seal", version: "3.14.7", build: "yurt_0" };
  // Agreeing: as without the check.
  assertEquals(sealVerification([python, seal], [python], true).verify, [
    seal,
  ]);
  assertEquals(sealVerification([python, seal], [], false).verify, [
    python,
    seal,
  ]);
  // The pins name a python the image does not ship: its stdlib would be
  // looked for in the image, where it is not.
  assertThrows(
    () => sealVerification([python, seal], [], true),
    Error,
    "does not ship the python its pins name",
  );
  assertThrows(
    () => sealVerification([python, seal], [python], false),
    Error,
    "ships a python its pins do not name",
  );
});

Deno.test("the Suspend/Resume kernel stages an image-shipped python's stdlib from the image, and checks the pins against the sandbox", async () => {
  // Scoped source checks: the worker is not loadable in a test.
  const source = await Deno.readTextFile(
    new URL("../src/notebook_kernel_worker.ts", import.meta.url),
  );
  // The verifying sandbox's list is checked against the pins.
  assertEquals(
    /sealVerification\(\s*\[set\.python, set\.seal\],\s*await installedReleases\(session\.files\) \?\? \[\],\s*set\.stdlibFromImage,\s*\)/
      .test(source),
    true,
    "verifySealSet passes the pins' word to sealVerification",
  );
  // A fresh boot stages the image's stdlib when it ships python, and the
  // archive's only when it does not.
  const boot = source.slice(
    source.indexOf("async function bootFresh("),
    source.indexOf("async function restoreStored("),
  );
  assertEquals(
    /,\s*sealSet\.stdlibFromImage \? stagedPath : \(path\) => path\.startsWith\("\/etc\/"\)/
      .test(boot),
    true,
    "the image's stdlib is staged when it ships python",
  );
  const archive = boot.indexOf("await fetchRelease(sealSet.python");
  const guard = boot.lastIndexOf("if (!sealSet.stdlibFromImage) {", archive);
  assertEquals(archive > 0 && guard > 0, true, "the archive only without");
  // No block closes between the guard and the fetch.
  assertEquals(
    /\n\s*\}\n/.test(boot.slice(guard, archive)),
    false,
    "the archive is fetched inside the guard",
  );
});
