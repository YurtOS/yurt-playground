// The desktop app's Playwright environment (`yurt-playground --playwright`):
// a Google Chrome window on this machine with its DevTools port open, and a
// sandbox that can reach it (yurt-desktop-host --host-loopback: the guest's
// 10.0.2.2:PORT is this machine's 127.0.0.1:PORT) with playwright-core and a
// `yurt-chrome` module in the login home, so a script there drives the
// window:
//
//   const page = await (await require("yurt-chrome").connect())
//     .contexts()[0].newPage();
//
// playwright-core is pure JavaScript; the browser it drives is the one
// here, attached over CDP, so nothing is downloaded into the guest but the
// package, which the launcher fetches and checks (sha512, as npm would).
import { join } from "node:path";

/** The package the guest gets: the playground's own Playwright (deno.json),
 *  with npm's integrity for its tarball. */
export const PLAYWRIGHT_CORE = {
  version: "1.55.0",
  tarball:
    "https://registry.npmjs.org/playwright-core/-/playwright-core-1.55.0.tgz",
  integrity:
    "sha512-GvZs4vU3U5ro2nZpeiwyb0zuFaqb9sUiAJuyrWpcGouD8y9/HLgGbNRjIph7zU9D3hnPaisMl9zG9CgFi/biIg==",
} as const;

/** The guest's name for this machine's loopback (yurt-desktop-host's
 *  host-local interface). */
export const HOST_FROM_GUEST = "10.0.2.2";

/** Where the login user's packages go: Node finds `~/node_modules` from any
 *  script under the home. */
export const GUEST_HOME = "/home/user";

/** Google Chrome's executable on this machine, or undefined. */
export async function findChrome(
  os: string = Deno.build.os,
  exists: (path: string) => Promise<boolean> = pathExists,
): Promise<string | undefined> {
  const candidates = os === "darwin"
    ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
    : [
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/opt/google/chrome/chrome",
    ];
  for (const path of candidates) {
    if (await exists(path)) return path;
  }
  return undefined;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Chrome's arguments: its own profile (never the user's, which Chrome
 *  refuses to open twice and which holds their sign-ins) and a DevTools
 *  port on loopback. */
export function chromeArgs(profileDir: string, port: number): string[] {
  return [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    // What Playwright passes the Chrome it launches: a window behind
    // others (or minimised) keeps its renderers running, or a page's load
    // never ends and every later attach waits on it.
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    // The profile keeps no passwords: no keychain prompt (macOS) or
    // keyring unlock (Linux) that would hold every page's load behind it.
    "--use-mock-keychain",
    "--password-store=basic",
    "about:blank",
  ];
}

/** A free loopback port for Chrome's DevTools. */
export function freePort(): number {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  listener.close();
  return port;
}

/** Start Chrome and wait until its DevTools port answers. */
export async function startChrome(
  chrome: string,
  profileDir: string,
  port: number = freePort(),
  timeoutMs = 20_000,
): Promise<{ port: number; version: string; stop: () => void }> {
  await Deno.mkdir(profileDir, { recursive: true });
  const child = new Deno.Command(chrome, {
    args: chromeArgs(profileDir, port),
    stdin: "null",
    stdout: "null",
    stderr: "null",
  }).spawn();
  const stop = () => {
    try {
      child.kill("SIGTERM");
    } catch {
      // already gone
    }
  };
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      const info = await response.json();
      return { port, version: info.Browser as string, stop };
    } catch {
      if (Date.now() > deadline) {
        stop();
        throw new Error(`Chrome's DevTools port ${port} did not answer`);
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}

/** The tarball, checked against its npm integrity. */
export async function fetchPlaywrightCore(
  fetcher: typeof fetch = fetch,
): Promise<Uint8Array> {
  const response = await fetcher(PLAYWRIGHT_CORE.tarball);
  if (!response.ok) {
    throw new Error(`${PLAYWRIGHT_CORE.tarball}: HTTP ${response.status}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-512", bytes));
  let binary = "";
  for (const byte of digest) binary += String.fromCharCode(byte);
  const integrity = `sha512-${btoa(binary)}`;
  if (integrity !== PLAYWRIGHT_CORE.integrity) {
    throw new Error(
      `playwright-core ${PLAYWRIGHT_CORE.version}: integrity ${integrity}, want ${PLAYWRIGHT_CORE.integrity}`,
    );
  }
  return bytes;
}

/** `~/node_modules/yurt-chrome/index.js`: the CDP endpoint of this launch's
 *  Chrome, as the guest reaches it. Chrome builds the WebSocket URL from
 *  the request's Host, so the guest's address carries through. */
export function yurtChromeModule(port: number): string {
  const url = `http://${HOST_FROM_GUEST}:${port}`;
  return `// Written by yurt-playground --playwright for this launch.
const cdpUrl = ${JSON.stringify(url)};
module.exports = {
  cdpUrl,
  /** The Chrome window on the host, as a Playwright Browser. */
  connect: () => require("playwright-core").chromium.connectOverCDP(cdpUrl),
};
`;
}

/** `~/playwright-example.js`: open a page, read it, screenshot it. */
export const EXAMPLE_SCRIPT = `// node playwright-example.js [url]
// Drives the Chrome window yurt-playground --playwright opened on the host.
const { connect } = require("yurt-chrome");
(async () => {
  const browser = await connect();
  console.log("connected to Chrome", browser.version());
  const page = await browser.contexts()[0].newPage();
  await page.goto(process.argv[2] ?? "https://example.com");
  console.log("title:", await page.title());
  await page.screenshot({ path: "playwright-example.png" });
  console.log("screenshot: ~/playwright-example.png");
  await browser.close(); // disconnects; the window stays
})().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
`;

/** What the launcher needs of the host: yurt-desktop-host's files and
 *  sessions (src/desktop_api.ts hostClient). */
export type GuestFiles = {
  writeFile(path: string, bytes: Uint8Array): Promise<void>;
  readFile(path: string): Promise<Uint8Array>;
  startSession(command: string): Promise<{ id: string }>;
  sessionComplete(id: string): Promise<boolean>;
  closeSession(id: string): Promise<number>;
};

/** The shell that unpacks the tarball into `~/node_modules`. */
export function unpackCommand(tgz: string, log: string): string {
  const dir = `${GUEST_HOME}/node_modules/playwright-core`;
  return `{ rm -rf ${dir} && mkdir -p ${dir} && ` +
    `tar -xzf ${tgz} -C ${dir} --strip-components=1 && rm -f ${tgz}; } ` +
    `> ${log} 2>&1`;
}

/** Install playwright-core, the yurt-chrome module and the example. */
export async function provisionGuest(
  guest: GuestFiles,
  tarball: Uint8Array,
  port: number,
): Promise<void> {
  const encode = (text: string) => new TextEncoder().encode(text);
  // In the home, not /tmp: the host writes it, and /tmp is sticky.
  const tgz = `${GUEST_HOME}/.playwright-core.tgz`;
  const log = `${GUEST_HOME}/.playwright-provision.log`;
  await guest.writeFile(tgz, tarball);
  const { id } = await guest.startSession(unpackCommand(tgz, log));
  while (!(await guest.sessionComplete(id))) {
    await new Promise((r) => setTimeout(r, 100));
  }
  const code = await guest.closeSession(id);
  if (code !== 0) {
    const output = new TextDecoder().decode(await guest.readFile(log));
    throw new Error(`unpacking playwright-core exited ${code}: ${output}`);
  }
  await guest.writeFile(
    join(GUEST_HOME, "node_modules/yurt-chrome/index.js"),
    encode(yurtChromeModule(port)),
  );
  await guest.writeFile(
    join(GUEST_HOME, "playwright-example.js"),
    encode(EXAMPLE_SCRIPT),
  );
}
