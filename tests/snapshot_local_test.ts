import { assertEquals, assertThrows } from "@std/assert";
import {
  captureBuild,
  captureQuery,
  defaultSnapshotName,
  isSnapshotRemote,
  restoreUrl,
  siteIdentityProblem,
  snapshotNameProblem,
} from "../scripts/snapshot-local.ts";
import { parsePins } from "../src/pins.ts";
import { snapshotIdentity } from "../src/sandbox_snapshot.ts";
import { NO_COMPLETE_SET } from "../src/python_install.ts";

const ID = "0123456789abcdef0123456789abcdef01234567";

Deno.test("snapshot-local prints a URL the page restores, and only for an id", () => {
  assertEquals(
    restoreUrl("https://yurt-playground.pages.dev", ID, "desktop"),
    `https://yurt-playground.pages.dev/?snapshot=${ID}&platform=desktop`,
  );
  assertEquals(
    restoreUrl("https://yurt-playground.pages.dev/", ID, "phone"),
    `https://yurt-playground.pages.dev/?snapshot=${ID}&platform=phone`,
  );
  // Go's restores on a desktop page that asks for Go.
  assertEquals(
    restoreUrl("https://yurt-playground.pages.dev/", ID, "go"),
    `https://yurt-playground.pages.dev/?snapshot=${ID}&platform=desktop&env=go`,
  );
  assertThrows(() => restoreUrl("https://x", "1", "desktop"));
});

Deno.test("snapshot-local captures with the page's own capture query", () => {
  assertEquals(captureQuery([], "desktop"), "start&snapshot=capture");
  assertEquals(
    captureQuery(["pandas", "scipy"], "desktop"),
    "start&snapshot=capture&packages=pandas,scipy",
  );
  assertEquals(captureQuery([], "phone"), "start&snapshot=capture-phone");
  assertEquals(captureQuery([], "tablet"), "start&snapshot=capture-tablet");
  assertEquals(captureQuery([], "go"), "start&snapshot=capture-go");
});

Deno.test("snapshot-local names a ref with one safe path segment", () => {
  assertEquals(
    defaultSnapshotName("t", new Date("2026-10-29T12:34:56.789Z")),
    "t-20261029T123456",
  );
  for (const good of ["a", "playground-2026.10.29-3d32068-x_1"]) {
    assertEquals(snapshotNameProblem(good), undefined);
  }
  for (const bad of ["", "-a", "a/b", "a..b", "a.lock", "a.", "a b", ".a"]) {
    assertEquals(typeof snapshotNameProblem(bad), "string", bad);
  }
});

Deno.test("snapshot-local pushes only to YurtOS/yurt-playground", () => {
  for (
    const url of [
      "https://github.com/YurtOS/yurt-playground.git",
      "https://github.com/YurtOS/yurt-playground",
      "git@github.com:YurtOS/yurt-playground.git",
      "ssh://git@github.com/YurtOS/yurt-playground.git",
    ]
  ) assertEquals(isSnapshotRemote(url), true, url);
  for (
    const url of [
      "https://github.com/someone/yurt-playground.git",
      "https://github.com/YurtOS/yurt-playground-fork.git",
      "/Users/me/yurt-playground",
    ]
  ) assertEquals(isSnapshotRemote(url), false, url);
});

Deno.test("snapshot-local refuses a checkout whose build the site does not run", async () => {
  const raw = JSON.parse(
    await Deno.readTextFile(new URL("../artifacts/pins.json", import.meta.url)),
  );
  const pins = parsePins({ ...raw, snapshot: undefined });
  const site = (body: unknown, status = 200) => (input: RequestInfo | URL) => {
    assertEquals(String(input), "https://pg.example/pins.json");
    return Promise.resolve(new Response(JSON.stringify(body), { status }));
  };
  assertEquals(
    await siteIdentityProblem("https://pg.example/", pins, site(raw)),
    undefined,
  );
  const behind = {
    ...raw,
    kernelWasm: { ...raw.kernelWasm, rev: "0".repeat(40) },
  };
  assertEquals(
    await siteIdentityProblem("https://pg.example", pins, site(behind)),
    `https://pg.example runs another build: this checkout's pins give kernelRev ${pins.kernelWasm.rev}, not ${
      "0".repeat(40)
    }`,
  );
  assertEquals(
    await siteIdentityProblem("https://pg.example", pins, site({}, 404)),
    "cannot read https://pg.example/pins.json: 404",
  );
});

Deno.test("snapshot-local expects each kind's own Python: the set, python alone, none", async () => {
  const raw = JSON.parse(
    await Deno.readTextFile(new URL("../artifacts/pins.json", import.meta.url)),
  );
  const pins = parsePins({ ...raw, snapshot: undefined });
  const set = "img/python@3.14.7-yurt_0:ab01e884f08e0619";
  for (const kind of ["desktop", "tablet"] as const) {
    assertEquals(captureBuild(pins, kind, set), {
      ok: true,
      builtFrom: { ...snapshotIdentity(pins), pythonSet: set },
    });
    for (const live of [undefined, NO_COMPLETE_SET]) {
      assertEquals(captureBuild(pins, kind, live).ok, false, String(live));
    }
  }
  // The phone's: no Python, whatever the index says (it is not asked).
  for (const live of [null, undefined, NO_COMPLETE_SET, set]) {
    assertEquals(captureBuild(pins, "phone", live), {
      ok: true,
      builtFrom: { ...snapshotIdentity(pins), pythonSet: null },
    });
  }
  // The tablet's and the phone's are the slim image's.
  const full = { ...pins, browserImage: undefined };
  assertEquals(captureBuild(full, "phone", null).ok, false);
  assertEquals(captureBuild(full, "tablet", set).ok, false);
});

Deno.test("snapshot-local expects Go's snapshot to hold the go package the live index offers", async () => {
  const raw = JSON.parse(
    await Deno.readTextFile(new URL("../artifacts/pins.json", import.meta.url)),
  );
  const pins = parsePins({ ...raw, snapshot: undefined });
  const go = "img/go@1.28.0-devel-yurt_1:0123456789abcdef";
  assertEquals(captureBuild(pins, "go", go), {
    ok: true,
    builtFrom: { ...snapshotIdentity(pins), pythonSet: go },
  });
  for (const live of [undefined, NO_COMPLETE_SET]) {
    assertEquals(captureBuild(pins, "go", live).ok, false, String(live));
  }
  // The slim image's, like the tablet's.
  assertEquals(
    captureBuild({ ...pins, browserImage: undefined }, "go", go).ok,
    false,
  );
});
