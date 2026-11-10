// `?env=playwright` on a desktop browser: once the shell runs, install node
// (pkg, through the page's relay), playwright-core (the site's own copy,
// src/playwright_assets.ts) and a `yurt-chrome` module into the sandbox, so
// `node playwright-example.js` in the terminal drives this browser through
// the guest's DevTools endpoint (src/cdp_bridge.ts) and the Yurt browser
// bridge extension (src/browser_bridge.ts).
import type { Yurt } from "./agent_api.ts";

export const HOME = "/home/user";

/** Where the modules go: Node searches `~/.node_modules` from any
 *  directory (one of its global folders), not only from under the home. */
export const MODULES = `${HOME}/.node_modules`;

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

/** The note for a browser without the extension. */
export const NO_EXTENSION_NOTE =
  "Playwright drives this browser through the Yurt browser bridge extension, " +
  "which is not installed: download yurt-browser-bridge.zip from this site, " +
  "unzip it, open chrome://extensions, turn on Developer mode, choose Load " +
  "unpacked and pick the folder, then reload this page.";

export const ASK_NOTE =
  "Playwright: the Yurt browser bridge opened a window asking whether this " +
  "sandbox may drive this browser; answer it to go on";

export const DENIED_NOTE =
  "Playwright: the bridge was not allowed to drive this browser; reload the " +
  "page to be asked again";

export const READY_NOTE =
  "Playwright is ready: in the terminal, node playwright-example.js " +
  "https://example.com opens a tab in this browser and drives it; " +
  'require("yurt-chrome").connect() in a script of your own.';

/** Set the sandbox up for Playwright. `say` reports progress and the
 *  outcome; resolves when done or failed (said either way). */
export async function setUpPlaywright(
  yurt: Yurt,
  { extension, approval, say, fetchAsset = fetch }: {
    /** Whether the bridge extension answers (src/browser_bridge.ts). */
    extension: boolean | Promise<boolean>;
    /** A person's answer, in the extension's window, to whether this tab
     *  may drive the browser. */
    approval?: () => Promise<boolean>;
    say: (text: string) => void;
    fetchAsset?: (path: string) => Promise<Response>;
  },
): Promise<boolean> {
  if (!(await extension)) {
    say(NO_EXTENSION_NOTE);
    return false;
  }
  if (approval !== undefined) {
    say(ASK_NOTE);
    if (!(await approval())) {
      say(DENIED_NOTE);
      return false;
    }
  }
  try {
    await yurt.ready;
    say("Setting up Playwright: installing node…");
    const node = await yurt.exec(
      "command -v node >/dev/null || { sudo pkg update && sudo pkg install node; } >/tmp/playwright-setup.log 2>&1; command -v node",
    );
    if (!("code" in node) || node.code !== 0) {
      throw new Error("node did not install (see /tmp/playwright-setup.log)");
    }
    say("Setting up Playwright: playwright-core…");
    const response = await fetchAsset("./playwright-core.tgz");
    if (!response.ok) {
      throw new Error(`playwright-core.tgz: HTTP ${response.status}`);
    }
    await yurt.fs.write(
      `${HOME}/.playwright-core.tgz`,
      new Uint8Array(await response.arrayBuffer()),
    );
    const unpack = await yurt.exec(
      `cd ${HOME} && rm -rf ${MODULES}/playwright-core && ` +
        `mkdir -p ${MODULES}/playwright-core ${MODULES}/yurt-chrome && ` +
        `tar -xzf .playwright-core.tgz -C ${MODULES}/playwright-core ` +
        "--strip-components=1 && rm .playwright-core.tgz",
    );
    if (!("code" in unpack) || unpack.code !== 0) {
      throw new Error("unpacking playwright-core failed");
    }
    await yurt.fs.write(
      `${MODULES}/yurt-chrome/index.js`,
      YURT_CHROME_MODULE,
    );
    await yurt.fs.write(`${HOME}/playwright-example.js`, EXAMPLE_SCRIPT);
    // The page serves the endpoint only for this env; say ready only once
    // the guest can reach it.
    const probe = await yurt.exec(
      "wget -q -T 5 -O- http://127.0.0.1:9222/json/version",
    );
    if (!("code" in probe) || probe.code !== 0) {
      throw new Error(
        "the sandbox's DevTools endpoint (127.0.0.1:9222) is not up",
      );
    }
    say(READY_NOTE);
    return true;
  } catch (error) {
    say(
      `Playwright setup failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return false;
  }
}
