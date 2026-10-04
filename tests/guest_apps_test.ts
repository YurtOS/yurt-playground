import { assertEquals } from "@std/assert";
import { appPrefix, GUEST_APPS, isGuestAppId } from "../src/guest_apps.ts";
import { appInlineScriptHashes, parsePins } from "../src/pins.ts";

Deno.test("registry ids, ports and prefixes", () => {
  assertEquals(GUEST_APPS.datasette.port, 8001);
  assertEquals(GUEST_APPS.preview.port, 8002);
  assertEquals(isGuestAppId("datasette"), true);
  assertEquals(isGuestAppId("preview"), true);
  assertEquals(isGuestAppId("bridge-sw.js"), false);
  assertEquals(isGuestAppId("_bridge"), false);
  assertEquals(
    appPrefix("preview", "11111111-1111-4111-8111-111111111111"),
    "/apps/preview/11111111-1111-4111-8111-111111111111/",
  );
});

Deno.test("preview is always qualified with no inline scripts; datasette follows pins", () => {
  const pin = (sha256: string, rev: string) => ({
    repo: "YurtOS/example",
    rev,
    build: "build.sh",
    path: "artifact",
    sha256,
  });
  const pins = parsePins({
    kernelWasm: pin("a".repeat(64), "d".repeat(40)),
    image: pin("b".repeat(64), "c".repeat(40)),
  });
  assertEquals(appInlineScriptHashes(pins, "preview"), []);
  assertEquals(appInlineScriptHashes(pins, "datasette"), undefined);
});
