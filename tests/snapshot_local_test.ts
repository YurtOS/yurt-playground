import { assertEquals, assertThrows } from "@std/assert";
import {
  captureQuery,
  defaultSnapshotName,
  isSnapshotRemote,
  restoreUrl,
  snapshotNameProblem,
} from "../scripts/snapshot-local.ts";

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
