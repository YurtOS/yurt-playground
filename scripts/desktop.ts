#!/usr/bin/env -S deno run --allow-read --allow-net --allow-run=open,xdg-open
// The desktop playground entry point: serve the built site (dist/) from a
// loopback port and open it in the default browser. The site sits beside
// the binary: Contents/Resources/dist in the macOS app, dist/ next to it in
// the Linux tarball, dist/ in the repository (scripts/build-desktop.sh).
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startDesktopServer } from "../src/desktop.ts";

const candidates = [
  join(dirname(Deno.execPath()), "../Resources/dist"),
  join(dirname(Deno.execPath()), "dist"),
  join(dirname(fileURLToPath(import.meta.url)), "../dist"),
];
let distDir: string | undefined;
for (const dir of candidates) {
  try {
    await Deno.stat(join(dir, "index.html"));
    distDir = dir;
    break;
  } catch {
    // try the next one
  }
}
if (distDir === undefined) {
  console.error(
    `no built site at ${candidates.join(" or ")}; run: deno task build-static`,
  );
  Deno.exit(2);
}

const { url } = startDesktopServer(distDir);
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
