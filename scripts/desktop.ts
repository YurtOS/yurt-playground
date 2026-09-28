#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env=HOME,USERPROFILE --allow-net --allow-run
// The desktop playground entry point: serve the built site (dist/) from a
// loopback port and open it in the default browser. The site sits beside
// the binary: Contents/Resources/dist in the macOS app, dist/ next to it in
// the Linux tarball, dist/ in the repository (scripts/build-desktop.sh).
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  claimLauncherState,
  freshApiToken,
  LAUNCHER_USAGE,
  type LauncherArgs,
  parseLauncherArgs,
  removeLauncherState,
  runningLauncher,
  startDesktopServer,
  writeLauncherState,
} from "../src/desktop.ts";
import {
  connectDesktopHost,
  type DesktopHost,
  RUNTIME_FILES,
  spawnDesktopHost,
} from "../src/desktop_host.ts";

let args: LauncherArgs;
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
// From a terminal window: hand the URL to the default browser. The page's
// own support gate says so if that browser cannot run the sandbox. A caller
// with stdout piped (tests, scripts) or --no-open gets the URL and nothing
// opened.
async function openInBrowser(url: string) {
  const opener = { darwin: "open", linux: "xdg-open" }[Deno.build.os as string];
  if (opener === undefined || !args.open || !Deno.stdout.isTerminal()) return;
  const { success } = await new Deno.Command(opener, { args: [url] }).output()
    .catch(() => ({ success: false }));
  if (!success) console.log(`Open ${url} in a browser.`);
}
const tokenFile = join(
  Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? ".",
  ".yurt",
  "playground.json",
);
// One sandbox per user: a second launch would boot another (~1 GB) and
// take the state file from the first. The claim is the state file itself,
// created exclusively before the boot; losing that race to another launch
// finds it booting. A record that is neither running nor removable
// (another user's file, say) would loop here forever; a few rounds settle
// any honest race.
for (let round = 0;; round++) {
  const running = await runningLauncher(tokenFile);
  if (running?.url !== undefined) {
    console.log(
      `yurt-playground is already running (pid ${running.pid}): ${running.url}`,
    );
    await openInBrowser(running.url);
    Deno.exit(0);
  }
  if (running !== null) {
    console.log(
      `yurt-playground is already starting (pid ${running.pid}); it prints its URL when the sandbox is up.`,
    );
    Deno.exit(0);
  }
  try {
    await Deno.mkdir(dirname(tokenFile), { recursive: true, mode: 0o700 });
    const state = { pid: Deno.pid, startedAt: Date.now() };
    if (await claimLauncherState(tokenFile, state)) break;
    if (round < 5) continue;
    console.error(
      `yurt-playground: ${tokenFile} names no running launcher but cannot be replaced; remove it and start again.`,
    );
    Deno.exit(1);
  } catch (error) {
    console.error(
      `yurt-playground: could not write ${tokenFile}: ${
        (error as Error).message
      }`,
    );
    break;
  }
}
// Deno.exit (the signal handler below, a failed boot) dispatches unload;
// only SIGKILL or a crash leaves the file for the next launch to clear.
globalThis.addEventListener(
  "unload",
  () => removeLauncherState(tokenFile, Deno.pid),
);
console.log("booting the sandbox…");
const child = spawnDesktopHost(runtimeDir);
let host: DesktopHost | undefined;
// Ctrl-C, kill, or the terminal window closing: take the host down with
// us. Its stdin closing is enough once it is up, but during the boot it
// does not read it, and would run on for the rest of the boot.
for (
  const [signal, code] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
    ["SIGHUP", 129],
  ] as const
) {
  Deno.addSignalListener(signal, () => {
    if (host === undefined) {
      // Booting: SIGTERM ends the host at once, but its runtime would run
      // the boot to the end before it noticed; end that too.
      try {
        new Deno.Command("pkill", {
          args: ["-TERM", "-P", String(child.pid)],
        }).outputSync();
      } catch {
        // no pkill: the runtime goes when its boot is done
      }
    }
    // Once up, the host tears the sandbox down on SIGTERM.
    try {
      child.kill("SIGTERM");
    } catch {
      // already gone
    }
    Deno.exit(code);
  });
}
try {
  host = await connectDesktopHost(child);
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
try {
  await writeLauncherState(tokenFile, { url, apiToken, pid: Deno.pid });
} catch (error) {
  console.error(
    `yurt-playground: could not write ${tokenFile}: ${
      (error as Error).message
    }`,
  );
}
console.log("Close this window to stop it.");
await openInBrowser(url);
