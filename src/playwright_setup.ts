// What makes a sandbox ready for Playwright, shared by the page's setup
// (src/playwright_demo.ts, on every ?env=playwright visit) and the
// Playwright snapshot's capture (src/coordinator_worker.ts, once per
// release): node, playwright-core in the login user's ~/.node_modules (a
// global folder Node searches from any directory), the yurt-chrome module
// and the example. Each step is skipped when its result is already there,
// so a page restored from the snapshot only checks.

export const HOME = "/home/user";

/** The extension's zip and playwright-core's tarball, as the site serves
 *  them (src/playwright_assets.ts makes them; public/index.html links the
 *  zip). Here, a module with no Deno API, so the page can import them. */
export const BRIDGE_ZIP = "yurt-browser-bridge.zip";
export const PLAYWRIGHT_CORE_TGZ = "playwright-core.tgz";

/** Where the modules go: Node searches `~/.node_modules` from any
 *  directory (one of its global folders), not only from under the home. */
export const MODULES = `${HOME}/.node_modules`;

/** The playwright-core the site serves (src/playwright_assets.ts packs the
 *  playground's own pin; tests/desktop_playwright... checks they match). */
export const PLAYWRIGHT_CORE_VERSION = "1.55.0";

/** `~/.node_modules/yurt-chrome/index.js`: the guest's DevTools endpoint. */
export const YURT_CHROME_MODULE =
  `// The browser this sandbox runs in, through the Yurt browser bridge.
const cdpUrl = "http://127.0.0.1:9222";
module.exports = {
  cdpUrl,
  /** This browser, as a Playwright Browser: newPage() opens a tab. */
  connect: () => require("playwright-core").chromium.connectOverCDP(cdpUrl),
};
`;

/** `~/playwright-example.js`: open a tab, read it, screenshot it. */
export const EXAMPLE_SCRIPT = `// node playwright-example.js [url]
// Opens a tab in this browser, reads it and takes a screenshot.
const { connect } = require("yurt-chrome");
(async () => {
  const browser = await connect();
  const page = await browser.contexts()[0].newPage();
  await page.goto(process.argv[2] ?? "https://example.com");
  console.log("title:", await page.title());
  const shot = require("node:path").join(require("node:os").homedir(), "playwright-example.png");
  await page.screenshot({ path: shot });
  console.log("screenshot:", shot);
  await browser.close(); // disconnects; the tab stays open
})().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
`;

/** The guest as the setup needs it: run a shell line as the login user
 *  (its exit code), write a file the login user owns, and the site's
 *  playwright-core tarball. */
export type PlaywrightGuest = {
  run(line: string): Promise<number>;
  write(path: string, bytes: Uint8Array): Promise<void>;
  tarball(): Promise<Uint8Array>;
};

/** Exits 0 when node runs. */
export const NODE_PRESENT = "command -v node >/dev/null";

/** Exits 0 when ~/.node_modules holds the playwright-core this site serves. */
export const CORE_PRESENT =
  `[ "$(node -p 'require("${MODULES}/playwright-core/package.json").version' 2>/dev/null)" = "${PLAYWRIGHT_CORE_VERSION}" ]`;

/** `script` as one exec'd shell, so a session's output and stdin
 *  redirects cover every command of a chain, not only the last
 *  (src/boot.ts: a line ends in an exec). */
export function shLine(script: string): string {
  return `exec /bin/sh -c '${script.replace(/'/g, "'\\''")}'`;
}

/** Unpack `tgz` (in the home) into ~/.node_modules/playwright-core. */
export function unpackLine(tgz: string): string {
  return shLine(
    `cd ${HOME} && rm -rf ${MODULES}/playwright-core && ` +
      `mkdir -p ${MODULES}/playwright-core ${MODULES}/yurt-chrome && ` +
      `tar -xzf ${tgz} -C ${MODULES}/playwright-core ` +
      `--strip-components=1 && rm ${tgz}`,
  );
}

/** Where the page's node install writes pkg's output. */
export const INSTALL_LOG = "/tmp/playwright-setup.log";

/** What {@link stagePlaywright} did: each step it found done is false. */
export type StageOutcome = { installedNode: boolean; unpackedCore: boolean };

/** Make `guest` ready for Playwright. `installNode` installs node when it
 *  is missing (the page: pkg through its relay; a capture has installed
 *  it as its set). `say` reports progress. Throws on a step that fails. */
export async function stagePlaywright(
  guest: PlaywrightGuest,
  { installNode, say = () => {} }: {
    installNode: () => Promise<void>;
    say?: (text: string) => void;
  },
): Promise<StageOutcome> {
  let installedNode = false;
  if (await guest.run(NODE_PRESENT) !== 0) {
    say("Setting up Playwright: installing node…");
    await installNode();
    if (await guest.run(NODE_PRESENT) !== 0) {
      throw new Error(`node did not install (see ${INSTALL_LOG})`);
    }
    installedNode = true;
  }
  let unpackedCore = false;
  if (await guest.run(CORE_PRESENT) !== 0) {
    say("Setting up Playwright: playwright-core…");
    const tgz = ".playwright-core.tgz";
    await guest.write(`${HOME}/${tgz}`, await guest.tarball());
    if (await guest.run(unpackLine(tgz)) !== 0) {
      throw new Error("unpacking playwright-core failed");
    }
    unpackedCore = true;
  }
  const encode = (text: string) => new TextEncoder().encode(text);
  // Small, and the module names this sandbox's endpoint: always written.
  await guest.write(
    `${MODULES}/yurt-chrome/index.js`,
    encode(YURT_CHROME_MODULE),
  );
  await guest.write(`${HOME}/playwright-example.js`, encode(EXAMPLE_SCRIPT));
  return { installedNode, unpackedCore };
}
