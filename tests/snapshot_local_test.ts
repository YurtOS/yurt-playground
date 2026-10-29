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
    restoreUrl("https://yurt-playground.pages.dev", ID, false),
    `https://yurt-playground.pages.dev/?snapshot=${ID}`,
  );
  assertEquals(
    restoreUrl("https://yurt-playground.pages.dev/", ID, true),
    `https://yurt-playground.pages.dev/?snapshot=${ID}&start-anyway`,
  );
  assertThrows(() => restoreUrl("https://x", "1", false));
});

Deno.test("snapshot-local captures with the page's own capture query", () => {
  assertEquals(captureQuery([], false), "start&snapshot=capture");
  assertEquals(
    captureQuery(["pandas", "scipy"], false),
    "start&snapshot=capture&packages=pandas,scipy",
  );
  assertEquals(captureQuery([], true), "start&snapshot=capture-phone");
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

Deno.test("snapshot-local expects the live set in a site capture, and no set in a phone's", async () => {
  const raw = JSON.parse(
    await Deno.readTextFile(new URL("../artifacts/pins.json", import.meta.url)),
  );
  const pins = parsePins({ ...raw, snapshot: undefined });
  const set = "img/python@3.14.7-yurt_0:ab01e884f08e0619";
  assertEquals(captureBuild(pins, false, set), {
    ok: true,
    builtFrom: { ...snapshotIdentity(pins), pythonSet: set },
  });
  for (const live of [undefined, NO_COMPLETE_SET]) {
    assertEquals(captureBuild(pins, false, live).ok, false, String(live));
  }
  // The phone's: no set, whatever the index says (it is not asked).
  for (const live of [null, undefined, NO_COMPLETE_SET, set]) {
    assertEquals(captureBuild(pins, true, live), {
      ok: true,
      builtFrom: { ...snapshotIdentity(pins), pythonSet: null },
    });
  }
});
