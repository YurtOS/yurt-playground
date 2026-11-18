import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  chooseEnv,
  choosePlatform,
  isFirefox,
  parsePlatform,
  platformSnapshotKind,
  withEnv,
  withPlatform,
} from "../src/device.ts";
import { TABLET_PYTHON_SET } from "../src/snapshot_pin.ts";

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
  assertEquals(chooseEnv("desktop", "go", { nativeApp: true }).env, "python");
  const unknown = chooseEnv("desktop", "rust");
  assertEquals(unknown.env, "python");
  assertStringIncludes(
    unknown.note!,
    "?env=rust is not python, go or playwright",
  );
});

Deno.test("?env=playwright is a desktop browser's", () => {
  assertEquals(chooseEnv("desktop", "playwright"), { env: "playwright" });
  assertEquals(chooseEnv("desktop", "Playwright"), { env: "playwright" });
  for (const platform of ["phone", "tablet"] as const) {
    const chosen = chooseEnv(platform, "playwright");
    assertEquals(chosen.env, "python");
    assertStringIncludes(chosen.note!, "desktop browser");
  }
  assertEquals(
    chooseEnv("desktop", "playwright", { nativeApp: true }).env,
    "python",
  );
});

Deno.test("?env=go on a site without a Go snapshot sets up Python, and says so", () => {
  // A bookmark or a shared link: booting the image would give neither Go
  // nor Python.
  const chosen = chooseEnv("desktop", "go", { goPinned: false });
  assertEquals(chosen.env, "python");
  assertStringIncludes(chosen.note!, "no Go sandbox yet");
});

Deno.test("a capture ignores ?env=: ?snapshot=capture-go makes Go's itself", () => {
  assertEquals(chooseEnv("desktop", "go", { capturing: true }), {
    env: "python",
  });
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

Deno.test("a phone restores the tablet's snapshot, with python, like a tablet", () => {
  assertEquals(platformSnapshotKind("phone"), "tablet");
  assertEquals(platformSnapshotKind("tablet"), "tablet");
  assertEquals(platformSnapshotKind("desktop"), "desktop");
  // The tablet's snapshot is the one that installs python.
  assertEquals(TABLET_PYTHON_SET.includes("python"), true);
});

Deno.test("Firefox and its Gecko builds are told apart from every other browser", () => {
  const firefox = [
    // Desktop, Android, and a Gecko fork that keeps the token.
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:140.0) Gecko/20100101 Firefox/140.0",
    "Mozilla/5.0 (Android 14; Mobile; rv:140.0) Gecko/140.0 Firefox/140.0",
    "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0 LibreWolf/128.0",
  ];
  const others = [
    // Chrome, Edge and Safari say "like Gecko", never "Firefox/".
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 Edg/142.0.0.0",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15",
    // Firefox on iOS is WebKit, which runs the sandbox.
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/140.0 Mobile/15E148 Safari/605.1.15",
  ];
  for (const ua of firefox) assertEquals(isFirefox(ua), true, ua);
  for (const ua of others) assertEquals(isFirefox(ua), false, ua);
});
