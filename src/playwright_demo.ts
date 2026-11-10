// `?env=playwright` on a desktop browser: once the shell runs, install node
// (pkg, through the page's relay), playwright-core (the site's own copy,
// src/playwright_assets.ts) and a `yurt-chrome` module into the sandbox, so
// `node playwright-example.js` in the terminal drives this browser through
// the guest's DevTools endpoint (src/cdp_bridge.ts) and the Yurt browser
// bridge extension (src/browser_bridge.ts).
import type { Yurt } from "./agent_api.ts";
import {
  BRIDGE_ZIP,
  INSTALL_LOG,
  shLine,
  stagePlaywright,
} from "./playwright_setup.ts";

export {
  EXAMPLE_SCRIPT,
  HOME,
  MODULES,
  YURT_CHROME_MODULE,
} from "./playwright_setup.ts";

export { BRIDGE_ZIP } from "./playwright_setup.ts";

/** The note for a browser without the extension: it names the zip, which
 *  the page shows as a link (src/page.ts). */
export const NO_EXTENSION_NOTE =
  "Playwright drives this browser through the Yurt browser bridge extension, " +
  `which is not installed: download ${BRIDGE_ZIP} from this site, unzip it, ` +
  "open chrome://extensions, turn on Developer mode, choose Load unpacked " +
  "and pick the folder, then reload this page";

export const OPENED_NOTE =
  "Playwright: this page was opened by another page, which could use it; " +
  "open the playground yourself (a new tab, or its address) to set Playwright up";

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
  { extension, approval, say, fetchAsset = fetch, openedByAnother = false }: {
    /** This page was opened by another one, which can script it. */
    openedByAnother?: boolean;
    /** Whether the bridge extension answers (src/browser_bridge.ts). */
    extension: boolean | Promise<boolean>;
    /** A person's answer, in the extension's window, to whether this tab
     *  may drive the browser. */
    approval?: () => Promise<boolean>;
    say: (text: string) => void;
    fetchAsset?: (path: string) => Promise<Response>;
  },
): Promise<boolean> {
  if (openedByAnother) {
    say(OPENED_NOTE);
    return false;
  }
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
    // A sandbox restored from the Playwright snapshot has it all: this
    // only checks (src/playwright_setup.ts).
    const code = async (line: string) => {
      const result = await yurt.exec(line);
      return "code" in result && result.code !== null ? result.code : -1;
    };
    const made = new Set<string>();
    await stagePlaywright({
      run: code,
      write: async (path, bytes) => {
        // Each directory once: a restored sandbox has them, and every
        // exec is a guest process.
        const dir = path.slice(0, path.lastIndexOf("/"));
        if (!made.has(dir)) {
          if (await code(`mkdir -p '${dir}'`) !== 0) {
            throw new Error(`cannot make ${dir}`);
          }
          made.add(dir);
        }
        await yurt.fs.write(path, bytes);
      },
      tarball: async () => {
        const response = await fetchAsset("./playwright-core.tgz");
        if (!response.ok) {
          throw new Error(`playwright-core.tgz: HTTP ${response.status}`);
        }
        return new Uint8Array(await response.arrayBuffer());
      },
    }, {
      say,
      installNode: async () => {
        await code(
          shLine(
            `{ sudo pkg update && sudo pkg install node; } >${INSTALL_LOG} 2>&1`,
          ),
        );
      },
    });
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
