/**
 * The desktop playground: the deployed site (`dist/`, see
 * scripts/build-static.ts) served from a local port with the same isolation
 * headers Cloudflare Pages applies from `_headers`, plus the native sandbox
 * behind `/desktop.json` and `/ws/*` when the bundle carries a runtime.
 *
 * Unlike the dev server (src/serve.ts) this serves the built tree as-is: the
 * image is already in parts, integrity.json is already written, nothing is
 * computed from public/ or artifacts/.
 */
import { join } from "node:path";
import { documentPolicy, inlineScriptHashes } from "./csp.ts";
import { createDesktopApi, hostClient } from "./desktop_api.ts";
import { type DesktopHost, proxyWebSocket } from "./desktop_host.ts";
import { contentType, directoryRule, ISOLATION_HEADERS } from "./serve.ts";

function notFound(): Response {
  return new Response("not found", {
    status: 404,
    headers: ISOLATION_HEADERS,
  });
}

/** `pathname` as a file under `distDir`, or null when it would leave it. */
export function resolveDistPath(
  distDir: string,
  pathname: string,
): string | null {
  const relative = (pathname === "/" ? "index.html" : pathname).replace(
    /^\/+/,
    "",
  );
  if (
    relative.includes("\0") || relative.includes("\\") ||
    relative.split("/").includes("..")
  ) {
    return null;
  }
  const resolved = join(distDir, relative);
  if (resolved !== distDir && !resolved.startsWith(`${distDir}/`)) {
    return null;
  }
  return resolved;
}

/** A request handler serving the built site under `distDir`. */
export function handleDistRequest(
  distDir: string,
): (req: Request) => Promise<Response> {
  return async (req) => {
    const url = new URL(req.url);
    let pathname: string;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      return notFound();
    }
    let filePath = resolveDistPath(distDir, pathname);
    if (filePath === null) return notFound();
    const directory = await directoryRule(filePath, url);
    if (directory instanceof Response) return directory;
    if (directory !== null) filePath = directory;
    let file: Deno.FsFile;
    try {
      file = await Deno.open(filePath);
    } catch {
      return notFound();
    }
    if (!(await file.stat()).isFile) {
      file.close();
      return notFound();
    }
    // The document's policy keys on the path served (`/jupyter/…` may eval).
    const path = directory !== null
      ? `${pathname}index.html`
      : pathname === "/"
      ? "/index.html"
      : pathname;
    const headers: Record<string, string> = {
      ...ISOLATION_HEADERS,
      "content-type": contentType(path),
    };
    if (path.endsWith(".html")) {
      // Same rule as the dev server and `_headers`: a document allows its own
      // inline scripts by hash, and JupyterLite's documents may eval.
      const html = await new Response(file.readable).text();
      headers["Content-Security-Policy"] = documentPolicy(
        path,
        await inlineScriptHashes(html),
      );
      return new Response(html, { headers });
    }
    return new Response(file.readable, { headers });
  };
}

/** What `yurt-playground` takes on its command line. */
export type LauncherArgs = {
  help: boolean;
  /** 0: a free port, printed in the URL. */
  port: number;
  /** Hand the URL to the default browser (a terminal only). */
  open: boolean;
};

export const LAUNCHER_USAGE = `usage: yurt-playground [--port N] [--no-open]

Boot the sandbox natively and serve the playground on a loopback port.
  --port N    listen on 127.0.0.1:N instead of a free port
  --no-open   print the URL but do not open a browser
  -h, --help  this text

A program on this machine drives the sandbox through <url>/api/* with the
bearer token the launcher prints; the token and URL are also written to
~/.yurt/playground.json (mode 0600) for the launcher's lifetime. While one
boots or runs, a second launch says so, with its URL once there is one
(and opens it), instead of booting another. The page's
window.yurt is the same API from the browser. See the README, "Driving the
sandbox from a program".`;

/** The launcher's command line, or an Error naming the argument. Small
 * enough to parse by hand: three flags, and a flag nobody knows is an
 * error rather than a boot (yurt-playground#90). */
export function parseLauncherArgs(argv: string[]): LauncherArgs {
  const args: LauncherArgs = { help: false, port: 0, open: true };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = (flag: string): string => {
      if (arg.startsWith(`${flag}=`)) return arg.slice(flag.length + 1);
      const next = argv[++i];
      if (next === undefined) throw new Error(`${flag} needs a value`);
      return next;
    };
    if (arg === "-h" || arg === "--help") args.help = true;
    else if (arg === "--no-open") args.open = false;
    else if (arg === "--port" || arg.startsWith("--port=")) {
      const text = value("--port");
      const port = Number(text);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`--port ${text}: want a port number`);
      }
      args.port = port;
    } else throw new Error(`unknown argument ${arg}\n${LAUNCHER_USAGE}`);
  }
  return args;
}

/** What `~/.yurt/playground.json` holds: `{pid}` while a launcher boots
 * its sandbox, then `url` and `apiToken` once it serves. */
export type LauncherState = {
  pid: number;
  url?: string;
  apiToken?: string;
};

/** Write `state` to a file of its own beside `stateFile`, whole, so a
 * reader never sees it half written. */
async function stagedState(
  stateFile: string,
  state: LauncherState,
): Promise<string> {
  const staged = `${stateFile}.${Deno.pid}.tmp`;
  await Deno.writeTextFile(staged, JSON.stringify(state) + "\n", {
    mode: 0o600,
  });
  return staged;
}

/** Create `stateFile` holding `state`, only if there is none: the claim
 * two launches race for. A hard link appears whole or not at all, where an
 * exclusive create is seen empty until its write lands (and a launch that
 * read it then took it for garbage). Null if another launch holds it.
 *
 * The claim is also an exclusive lock (flock) on the claimed file, taken
 * before the link so no reader sees the file unlocked. The kernel drops
 * it when the returned file closes, which it does when this process ends
 * however it ends, SIGKILL included; a child does not inherit it (Deno
 * opens files close-on-exec). Keep the file open while the claim should
 * hold. */
export async function claimLauncherState(
  stateFile: string,
  state: LauncherState,
): Promise<Deno.FsFile | null> {
  const staged = await stagedState(stateFile, state);
  let claim: Deno.FsFile | undefined;
  try {
    claim = await Deno.open(staged, { read: true });
    await claim.lock(true);
    await Deno.link(staged, stateFile);
    return claim;
  } catch (error) {
    claim?.close();
    if (error instanceof Deno.errors.AlreadyExists) return null;
    throw error;
  } finally {
    await Deno.remove(staged).catch(() => undefined);
  }
}

/** Replace `stateFile` with `state` in one step (a rename). */
export async function writeLauncherState(
  stateFile: string,
  state: LauncherState,
): Promise<void> {
  const staged = await stagedState(stateFile, state);
  try {
    await Deno.rename(staged, stateFile);
  } catch (error) {
    await Deno.remove(staged).catch(() => undefined);
    throw error;
  }
}

/** Remove `stateFile` if it still holds `text`, the record judged stale.
 * Two launches that both read one stale record both come here: the second
 * must not remove the claim the first made in its place. The file is moved
 * aside first, so what is checked is what was taken; a newer claim taken
 * by mistake goes back. */
async function removeStale(stateFile: string, text: string): Promise<void> {
  const aside = `${stateFile}.${Deno.pid}.stale`;
  try {
    await Deno.rename(stateFile, aside);
  } catch {
    return; // already gone
  }
  if ((await Deno.readTextFile(aside).catch(() => text)) !== text) {
    await Deno.link(aside, stateFile).catch(() => undefined);
  }
  await Deno.remove(aside).catch(() => undefined);
}

/** The whole of `file`, from where it is. */
async function readAllText(file: Deno.FsFile): Promise<string> {
  const chunks: Uint8Array[] = [];
  for (;;) {
    const chunk = new Uint8Array(4096);
    const n = await file.read(chunk);
    if (n === null) break;
    chunks.push(chunk.subarray(0, n));
  }
  const whole = new Uint8Array(chunks.reduce((sum, c) => sum + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    whole.set(c, at);
    at += c.length;
  }
  return new TextDecoder().decode(whole);
}

/** Whether the launcher that claimed the file open as `file` still runs:
 * its claim's lock (see `claimLauncherState`) is still held. A shared lock
 * conflicts only with that one, so two launches checking at once do not
 * take each other for the claim. */
function claimHeld(file: Deno.FsFile): boolean {
  if (!file.tryLockSync(false)) return true;
  file.unlockSync();
  return false;
}

/** The launcher `stateFile` names, if it still boots or serves. A file
 * left by one that could not clean up (SIGKILL, a crash) is removed. A
 * live pid proves nothing (pids are reused), so a booting record must
 * still be locked by its claim, and a recorded URL must answer as a
 * launcher does. */
export async function runningLauncher(
  stateFile: string,
): Promise<LauncherState | null> {
  let file: Deno.FsFile;
  try {
    file = await Deno.open(stateFile, { read: true });
  } catch {
    // None, or one this user cannot read (the launcher's claim then
    // fails, naming it).
    return null;
  }
  // The text and the lock checked are the same file's: a rename can put
  // another file at `stateFile` in between two opens.
  let text: string;
  let held: boolean;
  try {
    text = await readAllText(file);
    held = claimHeld(file);
  } finally {
    file.close();
  }
  let state: LauncherState;
  try {
    state = JSON.parse(text);
  } catch {
    await removeStale(stateFile, text);
    return null;
  }
  if (state.url === undefined) {
    if (held) return state;
    await removeStale(stateFile, text);
    return null;
  }
  try {
    const response = await fetch(new URL("desktop.json", state.url), {
      signal: AbortSignal.timeout(2000),
    });
    if (response.ok && (await response.json()).native === true) return state;
    await response.body?.cancel();
  } catch {
    // nothing listens there any more
  }
  await removeStale(stateFile, text);
  return null;
}

/** Remove `stateFile` if the launcher with `pid` wrote it. Synchronous:
 * it runs from the launcher's `unload`, as the process exits. */
export function removeLauncherState(stateFile: string, pid: number): void {
  try {
    if (JSON.parse(Deno.readTextFileSync(stateFile)).pid === pid) {
      Deno.removeSync(stateFile);
    }
  } catch {
    // no file, or not ours
  }
}

/** A token for this launch's `/api/*`: 128 random bits, hex. */
export function freshApiToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Serve `distDir` on a loopback port (a free one unless `port` says).
 * With a native host, the page learns so from `/desktop.json` and its
 * `/ws/*` sockets are relayed to it (src/desktop_host.ts), and `/api/*`
 * runs commands and moves files for a driver (src/desktop_api.ts) --
 * behind `apiToken`, which `/desktop.json` hands the page. */
export function startDesktopServer(
  distDir: string,
  host?: DesktopHost,
  options: { port?: number; apiToken?: string } = {},
): { url: string; shutdown: () => Promise<void> } {
  const files = handleDistRequest(distDir);
  const apiToken = options.apiToken ?? freshApiToken();
  let api: ReturnType<typeof createDesktopApi> | undefined;
  const handle = host === undefined ? files : (req: Request) => {
    const url = new URL(req.url);
    const path = url.pathname;
    if (path === "/api" || path.startsWith("/api/")) {
      api ??= createDesktopApi({
        host: hostClient(host.request),
        token: apiToken,
        bootMs: host.bootMs,
        available: host.sessions,
      });
      return api.handle(req) ?? files(req);
    }
    // Browsers apply no same-origin policy to WebSocket connects, so a page
    // from anywhere could otherwise open a shell here; only the page this
    // server serves (its own origin) may reach the sandbox.
    const origin = req.headers.get("origin");
    if (
      (path === "/desktop.json" || path.startsWith("/ws/")) &&
      origin !== null && origin !== url.origin
    ) {
      return Promise.resolve(
        new Response("not this page", {
          status: 403,
          headers: ISOLATION_HEADERS,
        }),
      );
    }
    if (path === "/desktop.json") {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            native: true,
            kernelPorts: host.kernelPorts,
            bootMs: host.bootMs,
            // The page's window.yurt goes through /api/*; a host without
            // the routes leaves the page with no token and the notice.
            ...(host.sessions ? { apiToken } : {}),
          }),
          {
            headers: {
              ...ISOLATION_HEADERS,
              "content-type": "application/json; charset=utf-8",
            },
          },
        ),
      );
    }
    if (path.startsWith("/ws/")) {
      return Promise.resolve(proxyWebSocket(req, host));
    }
    return files(req);
  };
  const server = Deno.serve(
    { port: options.port ?? 0, hostname: "127.0.0.1", onListen: () => {} },
    handle,
  );
  const addr = server.addr;
  if (!("port" in addr)) {
    throw new Error("desktop server did not bind a TCP port");
  }
  return {
    url: `http://127.0.0.1:${addr.port}/`,
    shutdown: () => server.shutdown(),
  };
}
