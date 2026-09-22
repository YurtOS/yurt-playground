/**
 * The desktop launcher's `/api/*`: the sandbox for a program on this
 * machine (yurt-playground#79, the desktop half). The same execution
 * registry as the hosted page's `window.yurt` (src/executions.ts) runs in
 * the launcher, over the native host's non-blocking sessions and guest
 * files (yurt-sandbox docs/desktop-host-api.md, "Sessions and files"), so
 * nothing here ever holds the runtime's serial dispatcher
 * (yurtos-kernel#2814). The desktop page's `window.yurt` and a local
 * `curl` both talk to this; one registry, one list, one limit.
 *
 * Every request needs `Authorization: Bearer <token>`; `Origin`, when
 * present, must be the launcher's own. The token is per launch: on the
 * launcher's stdout, in `~/.yurt/playground.json` (0600), and in
 * `/desktop.json` for the page. A local process running as the user is
 * the user; that is the threat model.
 */
import {
  createYurt,
  type DirEntry,
  PathError,
  type Yurt,
  type YurtTransport,
} from "./agent_api.ts";
import type { HostRequest } from "./desktop_host.ts";
import {
  type ExecOptions,
  ExecutionRegistry,
  MAX_ACTIVE_EXECUTIONS,
  quoted,
  type SpawnedProcess,
  type Spawner,
} from "./executions.ts";
import { ISOLATION_HEADERS } from "./serve.ts";

/** The most a `/api/fs/content` PUT may carry, and a GET may return. */
export const FS_CONTENT_LIMIT = 64 * 1024 * 1024;

type HostFailure = { status: number; error: string };

async function hostError(response: Response): Promise<HostFailure> {
  const text = await response.text().catch(() => "");
  let error = text;
  try {
    error = JSON.parse(text).error ?? text;
  } catch {
    // not JSON: the text is the message
  }
  return { status: response.status, error: error || response.statusText };
}

class HostRequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

async function expectOk(response: Response): Promise<Response> {
  if (response.ok) return response;
  const { status, error } = await hostError(response);
  throw new HostRequestError(status, error);
}

/** The host's session and file routes, typed. */
export function hostClient(request: HostRequest) {
  const file = (path: string) => `fs/content?path=${encodeURIComponent(path)}`;
  return {
    async startSession(command: string): Promise<{ id: string; pid: number }> {
      const response = await expectOk(
        await request("sessions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ command }),
        }),
      );
      return await response.json();
    },
    async sessionComplete(id: string): Promise<boolean> {
      const response = await expectOk(
        await request(`sessions/${encodeURIComponent(id)}`),
      );
      return (await response.json()).complete === true;
    },
    async closeSession(id: string): Promise<number> {
      const response = await expectOk(
        await request(`sessions/${encodeURIComponent(id)}`, {
          method: "DELETE",
        }),
      );
      return (await response.json()).exitCode;
    },
    async readFile(path: string): Promise<Uint8Array> {
      const response = await expectOk(await request(file(path)));
      return new Uint8Array(await response.arrayBuffer());
    },
    async writeFile(path: string, bytes: Uint8Array): Promise<void> {
      await expectOk(
        await request(file(path), {
          method: "PUT",
          headers: { "content-type": "application/octet-stream" },
          body: bytes as BodyInit,
        }),
      );
    },
    async removeFile(path: string): Promise<void> {
      const response = await request(file(path), { method: "DELETE" });
      // Gone already is gone.
      if (!response.ok && response.status !== 404) await expectOk(response);
      await response.body?.cancel();
    },
    async fileSize(path: string): Promise<number | undefined> {
      const response = await request(
        `fs/stat?path=${encodeURIComponent(path)}`,
      );
      if (response.status === 404) {
        await response.body?.cancel();
        return undefined;
      }
      return (await (await expectOk(response)).json()).size;
    },
  };
}

export type HostClient = ReturnType<typeof hostClient>;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A `Spawner` and a signaller over the native host: the command's three
 * streams go through files under /tmp exactly as the in-tab adapter's do
 * (src/boot.ts `process`), because a session's pipes are the runtime's
 * and nothing non-blocking reads them; `stdin` is a file the runtime
 * writes, bytes exact; the outputs are read back once the session is
 * complete, bounded by a `head` of the guest's own when the file is
 * larger than the bound, so a `yes > out` never lands in this process. */
export function nativeSpawner(
  host: HostClient,
  options: { pollMs?: number; sweepMs?: number } = {},
): {
  spawn: Spawner;
  signal: (pid: number, signal: number) => Promise<void>;
} {
  const pollMs = options.pollMs ?? 100;
  // The registry reads the files right after the exit; the sweep comes
  // well after, whichever way the exit went.
  const sweepMs = options.sweepMs ?? 5000;
  /** Start `command` as a session of its own and see it out: the exit
   * status, the session closed. */
  const run = async (command: string): Promise<number> => {
    const { id } = await host.startSession(command);
    while (!(await host.sessionComplete(id))) await sleep(pollMs);
    return await host.closeSession(id);
  };
  /** Up to `cap` bytes of a guest file; nothing for an absent one. */
  const boundedRead = async (
    path: string,
    cap: number,
  ): Promise<Uint8Array> => {
    const size = await host.fileSize(path);
    if (size === undefined) return new Uint8Array();
    if (size <= cap) return await host.readFile(path);
    const cut = `${path}.head`;
    await run(`head -c ${cap} -- ${quoted(path)} > ${quoted(cut)}`);
    try {
      return await host.readFile(cut);
    } finally {
      await host.removeFile(cut).catch(() => undefined);
    }
  };
  const spawn: Spawner = async (line, io): Promise<SpawnedProcess> => {
    const tag = crypto.randomUUID();
    const path = (name: string) => `/tmp/.yurt-exec-${tag}.${name}`;
    let stdinRedirect = "< /dev/null";
    if (io.stdin !== undefined) {
      await host.writeFile(path("in"), io.stdin);
      stdinRedirect = `< ${quoted(path("in"))}`;
    }
    const { id, pid } = await host.startSession(
      `${line} > ${quoted(path("out"))} 2> ${
        quoted(path("err"))
      } ${stdinRedirect}`,
    );
    const cap = io.maxOutputBytes + 1;
    const captured: { out?: Uint8Array; err?: Uint8Array } = {};
    // The exit is reported only once the outputs are in hand: the
    // registry takes them synchronously right after.
    const exited = (async () => {
      while (!(await host.sessionComplete(id))) await sleep(pollMs);
      const code = await host.closeSession(id);
      captured.out = await boundedRead(path("out"), cap);
      captured.err = await boundedRead(path("err"), cap);
      return code;
    })();
    const sweep = () => {
      for (const name of ["out", "err", "in"]) {
        void host.removeFile(path(name)).catch(() => undefined);
      }
    };
    exited.finally(() => setTimeout(sweep, sweepMs)).catch(() => {});
    const take = (stream: "out" | "err") => {
      const bytes = captured[stream];
      captured[stream] = undefined;
      return bytes ?? new Uint8Array();
    };
    return {
      pid,
      exited,
      takeStdout: () => take("out"),
      takeStderr: () => take("err"),
      peek: async () => ({
        stdout: await boundedRead(path("out"), cap),
        stderr: await boundedRead(path("err"), cap),
      }),
    };
  };
  const signal = async (pid: number, signal: number) => {
    // A session's process is no group leader (its group is init's), so
    // there is no group to signal: the command's descendants are found
    // through /proc (each stat's fourth field is the parent) and the
    // whole tree signalled at once, before any of them can be orphaned.
    await run(buildTreeKill(pid, signal));
  };
  return { spawn, signal };
}

/** One shell line that signals `pid` and every process descended from
 * it, collected first so a parent's death cannot orphan a child out of
 * the set. Shell builtins only (`read`, `kill`); no process per entry. */
export function buildTreeKill(pid: number, signal: number): string {
  return [
    `t='${pid}'; n="$t"`,
    'while [ -n "$n" ]; do c=""',
    'for d in /proc/[0-9]*; do read -r s < "$d/stat" 2>/dev/null || continue',
    "r=${s##*) }; set -- $r",
    'for q in $n; do [ "$2" = "$q" ] && c="$c ${d#/proc/}"; done; done',
    'n="$c"; t="$t$c"; done',
    `kill -${signal} $t 2>/dev/null; true`,
  ].join("; ");
}

/** An error code a driver can act on, from the message. */
function errorCode(error: unknown): { status: number; code: string } {
  if (error instanceof PathError) return { status: 400, code: "BadPath" };
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith("TooManyExecutions")) {
    return { status: 429, code: "TooManyExecutions" };
  }
  if (message.startsWith("no execution ")) {
    return { status: 404, code: "NoSuchExecution" };
  }
  if (message.includes("No such file or directory")) {
    return { status: 404, code: "NotFound" };
  }
  if (message.includes("Permission denied")) {
    return { status: 403, code: "PermissionDenied" };
  }
  if (
    message.includes("Is a directory") || message.includes("Not a directory")
  ) {
    return { status: 400, code: "NotAFile" };
  }
  return { status: 500, code: "Failed" };
}

const JSON_HEADERS = {
  ...ISOLATION_HEADERS,
  "content-type": "application/json; charset=utf-8",
  // Whatever a page is told about its own origin, a cached result is
  // read once.
  "cache-control": "no-store",
};

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: JSON_HEADERS });
}

function refuse(status: number, code: string, error: string): Response {
  return json({ error, code }, status);
}

function failure(error: unknown): Response {
  const { status, code } = errorCode(error);
  return refuse(
    status,
    code,
    error instanceof Error ? error.message : String(error),
  );
}

/** Constant-time equality for the token: a byte-by-byte compare would let
 * a local guesser time the match, however little that is worth here. */
function sameToken(presented: string, expected: string): boolean {
  const a = new TextEncoder().encode(presented);
  const b = new TextEncoder().encode(expected);
  let diff = a.byteLength ^ b.byteLength;
  for (let i = 0; i < Math.max(a.byteLength, b.byteLength); i++) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}

/** The request's spawn options, checked field by field: a driver's typo
 * is a 400 that names it, not a command run with a default. */
export function parseExecRequest(
  body: unknown,
): { cmd: string; opts: ExecOptions } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new PathError("the body must be a JSON object");
  }
  const b = body as Record<string, unknown>;
  if (typeof b.cmd !== "string" || b.cmd === "") {
    throw new PathError("cmd: a non-empty string");
  }
  const opts: ExecOptions = {};
  if (b.stdin !== undefined) {
    if (typeof b.stdin !== "string") throw new PathError("stdin: a string");
    opts.stdin = b.stdin;
  }
  if (b.stdinBase64 !== undefined) {
    if (typeof b.stdinBase64 !== "string") {
      throw new PathError("stdinBase64: a base64 string");
    }
    if (opts.stdin !== undefined) {
      throw new PathError("stdin and stdinBase64: one or the other");
    }
    try {
      opts.stdin = Uint8Array.from(atob(b.stdinBase64), (c) => c.charCodeAt(0));
    } catch {
      throw new PathError("stdinBase64: not base64");
    }
  }
  for (const field of ["timeoutMs", "maxOutputBytes"] as const) {
    if (b[field] === undefined) continue;
    const value = b[field];
    if (
      typeof value !== "number" || !Number.isInteger(value) || value < 0 ||
      (field === "maxOutputBytes" && value > FS_CONTENT_LIMIT)
    ) {
      throw new PathError(
        `${field}: a non-negative integer${
          field === "maxOutputBytes" ? ` up to ${FS_CONTENT_LIMIT}` : ""
        }`,
      );
    }
    opts[field] = value;
  }
  if (b.cwd !== undefined) {
    if (typeof b.cwd !== "string" || !b.cwd.startsWith("/")) {
      throw new PathError("cwd: an absolute path");
    }
    opts.cwd = b.cwd;
  }
  if (b.env !== undefined) {
    if (
      typeof b.env !== "object" || b.env === null || Array.isArray(b.env)
    ) {
      throw new PathError("env: an object of string or null values");
    }
    for (const [key, value] of Object.entries(b.env)) {
      if (value !== null && typeof value !== "string") {
        throw new PathError(`env.${key}: a string or null`);
      }
    }
    opts.env = b.env as Record<string, string | null>;
  }
  return { cmd: b.cmd, opts };
}

export type DesktopApi = {
  /** The response for a request under `/api/`, or undefined for any
   * other path. */
  handle: (req: Request) => Promise<Response> | undefined;
  /** The launcher's own view: what the routes are made of. */
  yurt: Yurt;
  registry: ExecutionRegistry;
};

export function createDesktopApi(options: {
  host: HostClient;
  token: string;
  bootMs: number;
  /** False for a host without the session routes (desktop-host before
   * v0.1.3): every authorized request is then a 503 that says so. */
  available?: boolean;
  pollMs?: number;
  sweepMs?: number;
}): DesktopApi {
  const { spawn, signal } = nativeSpawner(options.host, {
    pollMs: options.pollMs,
    sweepMs: options.sweepMs,
  });
  const registry = new ExecutionRegistry(spawn, signal, {
    pollMs: options.pollMs,
  });
  const transport: YurtTransport = {
    spawn: (cmd, opts) => registry.spawn(cmd, opts),
    wait: (id) => registry.wait(id),
    waitRaw: (id) => registry.waitRaw(id),
    kill: (id, signal) => registry.kill(id, signal),
    list: () => Promise.resolve(registry.list()),
  };
  const yurt = createYurt(transport, {
    current: () => "running",
    ready: Promise.resolve(),
  }, () => {
    throw new Error("download: not on the launcher");
  });

  const authorize = (req: Request, url: URL): Response | undefined => {
    const auth = req.headers.get("authorization") ?? "";
    const presented = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    if (presented === "" || !sameToken(presented, options.token)) {
      return refuse(401, "Unauthorized", "Authorization: Bearer <token>");
    }
    // The launcher's own origin is the one this request was made to: the
    // same page reaches it as 127.0.0.1 or as localhost, and a same-origin
    // request names that host in both places. Anything else is a page from
    // elsewhere.
    const origin = req.headers.get("origin");
    if (origin !== null && origin !== url.origin) {
      return refuse(403, "Forbidden", `not this page: ${origin}`);
    }
    if (req.headers.get("sec-fetch-site") === "cross-site") {
      return refuse(403, "Forbidden", "not this site");
    }
    return undefined;
  };

  const route = async (req: Request, url: URL): Promise<Response> => {
    const path = url.pathname.slice("/api".length);
    const method = req.method;
    if (path === "/status" && method === "GET") {
      return json({
        native: true,
        status: "running",
        bootMs: options.bootMs,
        executions: { active: registry.active(), limit: MAX_ACTIVE_EXECUTIONS },
      });
    }
    if (path === "/executions" && method === "GET") {
      return json(registry.list());
    }
    if (path === "/executions" && method === "POST") {
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return refuse(400, "BadRequest", "the body must be JSON");
      }
      const { cmd, opts } = parseExecRequest(body);
      const id = await registry.spawn(cmd, opts);
      return json({ id }, 201);
    }
    const execution = path.match(/^\/executions\/([^/]+)$/);
    if (execution !== null) {
      const id = decodeURIComponent(execution[1]);
      if (method === "GET") {
        if (url.searchParams.get("wait") === "1") {
          return json(await registry.wait(id));
        }
        const record = registry.list().find((r) => r.id === id);
        if (record === undefined) {
          return refuse(404, "NoSuchExecution", `no execution ${id}`);
        }
        return json(record);
      }
      if (method === "DELETE") {
        let signal: string | undefined;
        const text = await req.text();
        if (text !== "") {
          let body: unknown;
          try {
            body = JSON.parse(text);
          } catch {
            return refuse(400, "BadRequest", "the body must be JSON");
          }
          const s = (body as { signal?: unknown })?.signal;
          if (s !== undefined && typeof s !== "string") {
            return refuse(400, "BadRequest", "signal: a string");
          }
          signal = s;
        }
        await registry.kill(id, signal);
        return new Response(null, { status: 204, headers: JSON_HEADERS });
      }
    }
    // The host's session route, as it is: a process of its own with no
    // registry around it -- what the page starts the notebook kernel as,
    // outside the user's shell (yurt-playground#82) and outside the
    // execution registry, whose timeout and slot cap do not fit a process
    // that lives as long as the page. Seen out by id: `complete` while it
    // runs, closed for its exit code.
    if (path === "/sessions" && method === "POST") {
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return refuse(400, "BadRequest", "the body must be JSON");
      }
      const command = (body as { command?: unknown })?.command;
      if (typeof command !== "string" || command === "") {
        return refuse(400, "BadRequest", "command: a shell line");
      }
      return json(await options.host.startSession(command), 201);
    }
    const session = path.match(/^\/sessions\/([^/]+)$/);
    if (session !== null) {
      const id = decodeURIComponent(session[1]);
      if (method === "GET") {
        return json({ complete: await options.host.sessionComplete(id) });
      }
      if (method === "DELETE") {
        return json({ exitCode: await options.host.closeSession(id) });
      }
    }
    if (path === "/fs/content" || path === "/fs/entries") {
      const target = url.searchParams.get("path");
      if (target === null) return refuse(400, "BadPath", "?path= is needed");
      if (path === "/fs/entries" && method === "GET") {
        const entries: DirEntry[] = await yurt.fs.list(target);
        return json(entries);
      }
      if (method === "GET") {
        const bytes = await yurt.fs.read(target);
        return new Response(bytes as BodyInit, {
          headers: {
            ...ISOLATION_HEADERS,
            "content-type": "application/octet-stream",
            "cache-control": "no-store",
          },
        });
      }
      if (method === "PUT") {
        const length = Number(req.headers.get("content-length") ?? "0");
        if (length > FS_CONTENT_LIMIT) {
          return refuse(413, "TooLarge", `at most ${FS_CONTENT_LIMIT} bytes`);
        }
        const bytes = new Uint8Array(await req.arrayBuffer());
        if (bytes.byteLength > FS_CONTENT_LIMIT) {
          return refuse(413, "TooLarge", `at most ${FS_CONTENT_LIMIT} bytes`);
        }
        const modeText = req.headers.get("x-yurt-mode");
        let mode: number | undefined;
        if (modeText !== null) {
          if (!/^[0-7]{3,4}$/.test(modeText)) {
            return refuse(400, "BadRequest", "X-Yurt-Mode: octal, e.g. 644");
          }
          mode = parseInt(modeText, 8);
        }
        const atomic = req.headers.get("x-yurt-atomic") !== "0";
        await yurt.fs.write(target, bytes, { mode, atomic });
        return new Response(null, { status: 204, headers: JSON_HEADERS });
      }
    }
    return refuse(404, "NoSuchRoute", `${method} ${url.pathname}`);
  };

  return {
    handle(req) {
      const url = new URL(req.url);
      if (url.pathname !== "/api" && !url.pathname.startsWith("/api/")) {
        return undefined;
      }
      const refused = authorize(req, url) ??
        (options.available === false
          ? refuse(
            503,
            "HostTooOld",
            "this yurt-desktop-host predates the session routes",
          )
          : undefined);
      if (refused !== undefined) {
        // The body is not read; let the connection go.
        void req.body?.cancel();
        return Promise.resolve(refused);
      }
      return route(req, url).catch(failure);
    },
    yurt,
    registry,
  };
}
