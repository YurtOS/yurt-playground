#!/usr/bin/env -S deno run --allow-read --allow-net --allow-run
// The desktop playground entry point: serve the built site (dist/) from a
// loopback port and open it in the default browser. The site sits beside
// the binary: Contents/Resources/dist in the macOS app, dist/ next to it in
// the Linux tarball, dist/ in the repository (scripts/build-desktop.sh).
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startDesktopServer } from "../src/desktop.ts";
import { RUNTIME_FILES, startDesktopHost } from "../src/desktop_host.ts";

const candidates = [
  join(dirname(Deno.execPath()), "../Resources"),
  dirname(Deno.execPath()),
  join(dirname(fileURLToPath(import.meta.url)), ".."),
];
let root: string | undefined;
for (const dir of candidates) {
  try {
    await Deno.stat(join(dir, "dist/index.html"));
    root = dir;
    break;
  } catch {
    // try the next one
  }
}
if (root === undefined) {
  console.error(
    `no built site under ${
      candidates.join(" or ")
    }; run: deno task build-static`,
  );
  Deno.exit(2);
}
const distDir = join(root, "dist");
// The native sandbox: runtime/ beside dist/ in a bundle
// (scripts/build-desktop.sh), runtime/<target>/ in a repository checkout
// (scripts/install-desktop-host.sh).
const hostPresent = (dir: string) =>
  Deno.stat(join(dir, RUNTIME_FILES.host)).then(() => true, () => false);
let runtimeDir = join(root, "runtime", Deno.build.target);
if (!(await hostPresent(runtimeDir))) runtimeDir = join(root, "runtime");
if (!(await hostPresent(runtimeDir))) {
  console.error(
    `no ${RUNTIME_FILES.host} in ${runtimeDir}; run: scripts/install-desktop-host.sh`,
  );
  Deno.exit(2);
}
console.log("booting the sandbox…");
const host = await startDesktopHost(runtimeDir);
console.error(`sandbox up in ${(host.bootMs / 1000).toFixed(1)} s`);
const { url } = startDesktopServer(distDir, host);
console.log(`Yurt playground: ${url}`);
console.log("Close this window to stop it.");
// From a terminal window: hand the URL to the default browser. The page's
// own support gate says so if that browser cannot run the sandbox. A caller
// with stdout piped (tests, scripts) gets the URL and nothing opened.
const opener = { darwin: "open", linux: "xdg-open" }[Deno.build.os as string];
if (opener !== undefined && Deno.stdout.isTerminal()) {
  const { success } = await new Deno.Command(opener, { args: [url] }).output()
    .catch(() => ({ success: false }));
  if (!success) console.log(`Open ${url} in a browser.`);
}
