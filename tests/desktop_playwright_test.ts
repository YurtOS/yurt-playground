import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
  chromeArgs,
  EXAMPLE_SCRIPT,
  fetchPlaywrightCore,
  findChrome,
  type GuestFiles,
  PLAYWRIGHT_CORE,
  provisionGuest,
  unpackCommand,
  yurtChromeModule,
} from "../src/desktop_playwright.ts";

Deno.test("the guest's playwright-core is the playground's own Playwright", async () => {
  const denoJson = JSON.parse(
    await Deno.readTextFile(new URL("../deno.json", import.meta.url)),
  );
  assertEquals(
    denoJson.imports.playwright,
    `npm:playwright@${PLAYWRIGHT_CORE.version}`,
  );
  assertStringIncludes(
    PLAYWRIGHT_CORE.tarball,
    `-${PLAYWRIGHT_CORE.version}.tgz`,
  );
});

Deno.test("Chrome gets its own profile and a loopback DevTools port", () => {
  const args = chromeArgs("/p", 9333);
  assertEquals(args.includes("--remote-debugging-port=9333"), true);
  assertEquals(args.includes("--user-data-dir=/p"), true);
  // A background window must not stall a page's load.
  assertEquals(args.includes("--disable-backgrounding-occluded-windows"), true);
  // Nor a keychain prompt nobody sees.
  assertEquals(args.includes("--use-mock-keychain"), true);
  // Never --remote-debugging-address: the port stays on loopback.
  assertEquals(args.some((a) => a.includes("remote-debugging-address")), false);
});

Deno.test("findChrome looks where each OS installs it", async () => {
  const seen: string[] = [];
  const none = (path: string) => (seen.push(path), Promise.resolve(false));
  assertEquals(await findChrome("darwin", none), undefined);
  assertEquals(seen, [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ]);
  assertEquals(
    await findChrome(
      "linux",
      (p) => Promise.resolve(p === "/opt/google/chrome/chrome"),
    ),
    "/opt/google/chrome/chrome",
  );
});

Deno.test("the tarball must match npm's integrity", async () => {
  const fake = () => Promise.resolve(new Response(new Uint8Array([1, 2, 3])));
  await assertRejects(
    () => fetchPlaywrightCore(fake as typeof fetch),
    Error,
    "integrity sha512-",
  );
  const missing = () => Promise.resolve(new Response("no", { status: 404 }));
  await assertRejects(
    () => fetchPlaywrightCore(missing as typeof fetch),
    Error,
    "HTTP 404",
  );
});

Deno.test("yurt-chrome points at the host's loopback as the guest sees it", () => {
  const module = yurtChromeModule(9333);
  assertStringIncludes(module, '"http://10.0.2.2:9333"');
  assertStringIncludes(module, "connectOverCDP(cdpUrl)");
  assertStringIncludes(EXAMPLE_SCRIPT, 'require("yurt-chrome")');
});

Deno.test("provisioning unpacks the tarball and writes the module and example", async () => {
  const written = new Map<string, Uint8Array>();
  const commands: string[] = [];
  let exitCode = 0;
  const guest: GuestFiles = {
    writeFile: (path, bytes) => (written.set(path, bytes), Promise.resolve()),
    readFile: () => Promise.resolve(new TextEncoder().encode("tar: bad")),
    startSession: (
      command,
    ) => (commands.push(command), Promise.resolve({ id: "s" })),
    sessionComplete: () => Promise.resolve(true),
    closeSession: () => Promise.resolve(exitCode),
  };
  await provisionGuest(guest, new Uint8Array([9]), 9333);
  assertEquals([...written.keys()], [
    "/home/user/.playwright-core.tgz",
    "/home/user/node_modules/yurt-chrome/index.js",
    "/home/user/playwright-example.js",
  ]);
  assertEquals(commands, [
    unpackCommand(
      "/home/user/.playwright-core.tgz",
      "/home/user/.playwright-provision.log",
    ),
  ]);
  assertStringIncludes(commands[0], "--strip-components=1");
  // A failed unpack stops the launch with the guest's own output.
  exitCode = 2;
  await assertRejects(
    () => provisionGuest(guest, new Uint8Array([9]), 9333),
    Error,
    "exited 2: tar: bad",
  );
});
