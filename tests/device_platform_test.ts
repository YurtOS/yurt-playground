import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  chooseEnv,
  choosePlatform,
  parsePlatform,
  withEnv,
  withPlatform,
} from "../src/device.ts";

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

Deno.test("?env=go is a desktop browser's only", () => {
  assertEquals(chooseEnv("desktop", null), { env: "python" });
  assertEquals(chooseEnv("desktop", "python"), { env: "python" });
  assertEquals(chooseEnv("desktop", "go"), { env: "go" });
  assertEquals(chooseEnv("desktop", "Go"), { env: "go" });
  // Never on a phone or tablet: their snapshots are never enlarged.
  for (const platform of ["phone", "tablet"] as const) {
    const chosen = chooseEnv(platform, "go");
    assertEquals(chosen.env, "python");
    assertStringIncludes(chosen.note!, "desktop browsers only");
  }
  // The desktop app's native sandbox installs what it likes.
  assertEquals(chooseEnv("desktop", "go", true).env, "python");
  const unknown = chooseEnv("desktop", "rust");
  assertEquals(unknown.env, "python");
  assertStringIncludes(unknown.note!, "?env=rust is not python or go");
});

Deno.test("withEnv writes Go into the URL and Python out of it", () => {
  assertEquals(
    withEnv("https://pg.example/?platform=desktop#x", "go"),
    "https://pg.example/?platform=desktop&env=go#x",
  );
  assertEquals(
    withEnv("https://pg.example/?platform=desktop&env=go", "python"),
    "https://pg.example/?platform=desktop",
  );
});
