import { assertEquals, assertRejects } from "@std/assert";
import {
  CORE_PRESENT,
  EXAMPLE_SCRIPT,
  MODULES,
  NODE_PRESENT,
  PLAYWRIGHT_CORE_VERSION,
  type PlaywrightGuest,
  stagePlaywright,
  YURT_CHROME_MODULE,
} from "../src/playwright_setup.ts";

/** A guest whose node and playwright-core are present or not. */
function guest(state: { node: boolean; core: boolean }) {
  const ran: string[] = [];
  const written: string[] = [];
  let fetched = 0;
  const io: PlaywrightGuest = {
    run: (line) => {
      ran.push(line);
      if (line === NODE_PRESENT) return Promise.resolve(state.node ? 0 : 1);
      if (line === CORE_PRESENT) return Promise.resolve(state.core ? 0 : 1);
      // The unpack: playwright-core is there afterwards.
      state.core = true;
      return Promise.resolve(0);
    },
    write: (path) => (written.push(path), Promise.resolve()),
    tarball: () => (fetched++, Promise.resolve(new Uint8Array([1]))),
  };
  return { io, ran, written, fetched: () => fetched };
}

Deno.test("a sandbox restored from the Playwright snapshot only checks", async () => {
  const g = guest({ node: true, core: true });
  let installs = 0;
  const outcome = await stagePlaywright(g.io, {
    installNode: () => (installs++, Promise.resolve()),
  });
  assertEquals(outcome, { installedNode: false, unpackedCore: false });
  assertEquals(installs, 0);
  assertEquals(g.fetched(), 0);
  // The small files are always written: the module names this sandbox's
  // endpoint.
  assertEquals(g.written, [
    `${MODULES}/yurt-chrome/index.js`,
    "/home/user/playwright-example.js",
  ]);
});

Deno.test("a bare sandbox gets node, playwright-core and the module", async () => {
  const state = { node: false, core: false };
  const g = guest(state);
  const outcome = await stagePlaywright(g.io, {
    installNode: () => (state.node = true, Promise.resolve()),
  });
  assertEquals(outcome, { installedNode: true, unpackedCore: true });
  assertEquals(g.fetched(), 1);
  assertEquals(g.written[0], "/home/user/.playwright-core.tgz");
  // A node that does not appear fails the setup.
  await assertRejects(
    () =>
      stagePlaywright(guest({ node: false, core: false }).io, {
        installNode: () => Promise.resolve(),
      }),
    Error,
    "node did not install",
  );
});

Deno.test("the staged playwright-core is the playground's own pin", async () => {
  const denoJson = JSON.parse(
    await Deno.readTextFile(new URL("../deno.json", import.meta.url)),
  );
  assertEquals(
    denoJson.imports.playwright,
    `npm:playwright@${PLAYWRIGHT_CORE_VERSION}`,
  );
  // The check compares that version, and the module and example name the
  // guest's endpoint.
  assertEquals(CORE_PRESENT.includes(`"${PLAYWRIGHT_CORE_VERSION}"`), true);
  assertEquals(YURT_CHROME_MODULE.includes("http://127.0.0.1:9222"), true);
  assertEquals(EXAMPLE_SCRIPT.includes('require("yurt-chrome")'), true);
});

Deno.test("the no-extension note names the zip, which the page shows as a link", async () => {
  const { BRIDGE_ZIP, NO_EXTENSION_NOTE } = await import(
    "../src/playwright_demo.ts"
  );
  assertEquals(BRIDGE_ZIP, "yurt-browser-bridge.zip");
  assertEquals(NO_EXTENSION_NOTE.split(BRIDGE_ZIP).length, 2);
});
