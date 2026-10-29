import { assertEquals, assertStringIncludes } from "@std/assert";
import { choosePlatform, parsePlatform, withPlatform } from "../src/device.ts";

Deno.test("a page with no ?platform= runs as its device and writes it into the URL", () => {
  for (const device of ["phone", "tablet", "desktop"] as const) {
    assertEquals(choosePlatform(device, null), {
      platform: device,
      redirect: true,
    });
  }
  assertEquals(
    withPlatform("https://pg.example/?start&snapshot=0#x", "tablet"),
    "https://pg.example/?start=&snapshot=0&platform=tablet#x",
  );
  assertEquals(
    withPlatform("https://pg.example/", "phone"),
    "https://pg.example/?platform=phone",
  );
});

Deno.test("?platform= overrides the device as far as it can run it, and is never written away", () => {
  // Its own, or smaller: as asked.
  assertEquals(choosePlatform("desktop", "phone"), {
    platform: "phone",
    redirect: false,
  });
  assertEquals(choosePlatform("tablet", "ipad"), {
    platform: "tablet",
    redirect: false,
  });
  assertEquals(choosePlatform("desktop", "Mac"), {
    platform: "desktop",
    redirect: false,
  });
  // Bigger than the device: its own, said.
  const forced = choosePlatform("phone", "desktop");
  assertEquals([forced.platform, forced.redirect], ["phone", false]);
  assertStringIncludes(forced.note!, "too little memory for the desktop page");
  assertEquals(choosePlatform("tablet", "desktop").platform, "tablet");
  assertEquals(choosePlatform("phone", "ipad").platform, "phone");
  // Not a platform: its own, said.
  const unknown = choosePlatform("desktop", "watch");
  assertEquals([unknown.platform, unknown.redirect], ["desktop", false]);
  assertStringIncludes(unknown.note!, "?platform=watch is not");
  assertEquals(parsePlatform("IPHONE"), "phone");
  assertEquals(parsePlatform(""), undefined);
});
