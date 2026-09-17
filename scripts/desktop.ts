#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env=HOME,USERPROFILE --allow-net --allow-run
// The desktop playground entry point: serve the built site (dist/) from a
// loopback port and open it in the default browser. The site sits beside
// the binary: Contents/Resources/dist in the macOS app, dist/ next to it in
// the Linux tarball, dist/ in the repository (scripts/build-desktop.sh).
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  freshApiToken,
  LAUNCHER_USAGE,
  parseLauncherArgs,
  startDesktopServer,
} from "../src/desktop.ts";
import { RUNTIME_FILES, startDesktopHost } from "../src/desktop_host.ts";

let args;
try {
  args = parseLauncherArgs(Deno.args);
} catch (error) {
  console.error(`yurt-playground: ${(error as Error).message}`);
  Deno.exit(2);
}
if (args.help) {
  console.log(LAUNCHER_USAGE);
  Deno.exit(0);
}
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
let host;
try {
  host = await startDesktopHost(runtimeDir);
} catch (error) {
  // The host's own stderr (the cause) is already on the terminal above
  // this line; a stack trace from here would only bury it.
  console.error(
    `yurt-playground: the sandbox did not start: ${(error as Error).message}`,
  );
  Deno.exit(1);
}
console.error(`sandbox up in ${(host.bootMs / 1000).toFixed(1)} s`);
const apiToken = freshApiToken();
let url: string;
try {
  url = startDesktopServer(distDir, host, { port: args.port, apiToken }).url;
} catch (error) {
  host.stop();
  console.error(
    `yurt-playground: cannot listen on 127.0.0.1:${args.port}: ${
      (error as Error).message
    }`,
  );
  Deno.exit(1);
}
console.log(`Yurt playground: ${url}`);
// A program on this machine drives the sandbox through /api/* with this
// token (README, "Driving the desktop app"); it is also left where a
// script finds it without the terminal, readable by this user alone.
console.log(`API token: ${apiToken}`);
const tokenFile = join(
  Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? ".",
  ".yurt",
  "playground.json",
);
try {
  await Deno.mkdir(dirname(tokenFile), { recursive: true, mode: 0o700 });
  await Deno.writeTextFile(
    tokenFile,
    JSON.stringify({ url, apiToken, pid: Deno.pid }) + "\n",
    { mode: 0o600 },
  );
  await Deno.chmod(tokenFile, 0o600).catch(() => undefined);
} catch (error) {
  console.error(
    `yurt-playground: could not write ${tokenFile}: ${
      (error as Error).message
    }`,
  );
}
console.log("Close this window to stop it.");
// From a terminal window: hand the URL to the default browser. The page's
// own support gate says so if that browser cannot run the sandbox. A caller
// with stdout piped (tests, scripts) or --no-open gets the URL and nothing
// opened.
const opener = { darwin: "open", linux: "xdg-open" }[Deno.build.os as string];
if (opener !== undefined && args.open && Deno.stdout.isTerminal()) {
  const { success } = await new Deno.Command(opener, { args: [url] }).output()
    .catch(() => ({ success: false }));
  if (!success) console.log(`Open ${url} in a browser.`);
}
