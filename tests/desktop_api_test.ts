import { assertEquals, assertThrows } from "@std/assert";
import {
  buildTreeKill,
  createDesktopApi,
  type HostClient,
  nativeSpawner,
  parseExecRequest,
} from "../src/desktop_api.ts";
import { PathError } from "../src/agent_api.ts";

/** The sweep of a command's files is a 0 ms timer in these tests; let it
 * run before the test ends. */
const swept = () => new Promise((resolve) => setTimeout(resolve, 5));

/** The host's session and file routes over a guest of three commands: a
 * line of the spawner's shape writes its outputs, `head -c` cuts a file,
 * `kill` is recorded. Enough to see what the spawner asks for. */
function fakeHost(
  options: { pollsToComplete?: number; exitCode?: number } = {},
) {
  const files = new Map<string, Uint8Array>();
  const commands: string[] = [];
  const sessions = new Map<string, { polls: number; exit: number }>();
  let next = 1;
  const encoder = new TextEncoder();
  const host: HostClient = {
    startSession(command) {
      commands.push(command);
      const id = `session-${next++}`;
      let exit = 0;
      const head = command.match(/^head -c (\d+) -- '([^']+)' > '([^']+)'$/);
      const exec = command.match(
        /^(.*) > '([^']+)' 2> '([^']+)' < (?:'([^']+)'|\/dev\/null)$/,
      );
      if (head !== null) {
        files.set(
          head[3],
          (files.get(head[2]) ?? new Uint8Array()).slice(0, Number(head[1])),
        );
      } else if (exec !== null) {
        const stdin = exec[4] === undefined
          ? new Uint8Array()
          : files.get(exec[4]) ?? new Uint8Array();
        // The command "echoes" its stdin upper-cased to stdout, its line
        // to stderr, so a test can see both streams came from the guest.
        files.set(
          exec[2],
          encoder.encode(new TextDecoder().decode(stdin).toUpperCase()),
        );
        files.set(exec[3], encoder.encode(`ran: ${exec[1]}\n`));
        exit = options.exitCode ?? 0;
      }
      // Only the command itself takes its time; a head or a kill is done
      // at the first look.
      sessions.set(id, {
        polls: exec !== null ? options.pollsToComplete ?? 1 : 1,
        exit,
      });
      return Promise.resolve({ id, pid: 40 + next });
    },
    sessionComplete(id) {
      const s = sessions.get(id)!;
      s.polls--;
      return Promise.resolve(s.polls <= 0);
    },
    closeSession(id) {
      const s = sessions.get(id)!;
      sessions.delete(id);
      return Promise.resolve(s.exit);
    },
    readFile(path) {
      const bytes = files.get(path);
      if (bytes === undefined) return Promise.reject(new Error("ENOENT"));
      return Promise.resolve(bytes);
    },
    writeFile(path, bytes) {
      files.set(path, bytes);
      return Promise.resolve();
    },
    removeFile(path) {
      files.delete(path);
      return Promise.resolve();
    },
    fileSize(path) {
      return Promise.resolve(files.get(path)?.byteLength);
    },
  };
  return { host, files, commands, sessions };
}

Deno.test("the native spawner stages stdin as a file, redirects the streams, reads them back once complete", async () => {
  const fake = fakeHost({ pollsToComplete: 3, exitCode: 7 });
  const { spawn } = nativeSpawner(fake.host, { pollMs: 1, sweepMs: 0 });
  const process = await spawn("exec tr a-z A-Z", {
    stdin: new TextEncoder().encode("hello\x00\xff"),
    maxOutputBytes: 1024,
  });
  assertEquals(fake.commands.length, 1);
  const line = fake.commands[0];
  assertEquals(
    line.startsWith("exec tr a-z A-Z > '/tmp/.yurt-exec-"),
    true,
    line,
  );
  assertEquals(/ < '\/tmp\/\.yurt-exec-[^']+\.in'$/.test(line), true, line);
  // Nothing to take before the exit; then both streams, once.
  assertEquals(process.takeStdout().byteLength, 0);
  assertEquals(await process.exited, 7);
  assertEquals(
    new TextDecoder().decode(process.takeStdout()),
    "HELLO\x00\xff".toUpperCase(),
  );
  assertEquals(
    new TextDecoder().decode(process.takeStderr()),
    "ran: exec tr a-z A-Z\n",
  );
  assertEquals(process.takeStdout().byteLength, 0);
  assertEquals(fake.sessions.size, 0, "the session was closed");
  await swept();
});

Deno.test("the native spawner never brings more than the bound into the launcher", async () => {
  const fake = fakeHost();
  const { spawn } = nativeSpawner(fake.host, { pollMs: 1, sweepMs: 0 });
  const process = await spawn("exec cat", {
    stdin: new TextEncoder().encode("x".repeat(100)),
    maxOutputBytes: 10,
  });
  await process.exited;
  // One byte past the bound, so the registry sees the cut; read through
  // a `head` of the guest's own, not a 100-byte transfer.
  assertEquals(process.takeStdout().byteLength, 11);
  assertEquals(
    fake.commands.some((c) => c.startsWith("head -c 11 -- ")),
    true,
    fake.commands.join("\n"),
  );
  assertEquals(
    [...fake.files.keys()].filter((f) => f.endsWith(".head")),
    [],
    "the cut file is removed",
  );
  await swept();
  assertEquals(
    [...fake.files.keys()].filter((f) => f.includes(".yurt-exec-")),
    [],
    "the streams' files are swept",
  );
});

Deno.test("the native spawner's peek reads the files while the command runs", async () => {
  const fake = fakeHost({ pollsToComplete: 1000 });
  const { spawn, signal } = nativeSpawner(fake.host, { pollMs: 1, sweepMs: 0 });
  const process = await spawn("exec yes", {
    stdin: new TextEncoder().encode("abc"),
    maxOutputBytes: 1024,
  });
  const peeked = await process.peek!();
  assertEquals(new TextDecoder().decode(peeked.stdout), "ABC");
  await signal(process.pid, 9);
  assertEquals(fake.commands.at(-1), buildTreeKill(process.pid, 9));
  assertEquals(
    buildTreeKill(7, 15).startsWith("t='7'; n=\"$t\"; while "),
    true,
  );
  assertEquals(
    buildTreeKill(7, 15).endsWith("kill -15 $t 2>/dev/null; true"),
    true,
  );
  // The fake never completes this session; the exit stays pending and the
  // test does not wait on it.
  fake.sessions.get("session-1")!.polls = 0;
  await process.exited;
  await swept();
});

Deno.test("parseExecRequest names the field a driver got wrong", () => {
  assertEquals(parseExecRequest({ cmd: "true" }), { cmd: "true", opts: {} });
  assertEquals(
    parseExecRequest({
      cmd: "cat",
      stdin: "x",
      timeoutMs: 5,
      maxOutputBytes: 10,
      cwd: "/tmp",
      env: { A: "1", B: null },
    }).opts,
    {
      stdin: "x",
      timeoutMs: 5,
      maxOutputBytes: 10,
      cwd: "/tmp",
      env: { A: "1", B: null },
    },
  );
  assertEquals(
    parseExecRequest({ cmd: "cat", stdinBase64: btoa("\x00\xff") }).opts.stdin,
    new Uint8Array([0, 255]),
  );
  for (
    const [body, field] of [
      [{}, "cmd"],
      [{ cmd: "" }, "cmd"],
      [{ cmd: "x", stdin: 1 }, "stdin"],
      [{ cmd: "x", stdin: "a", stdinBase64: "YQ==" }, "stdin and stdinBase64"],
      [{ cmd: "x", stdinBase64: "%%" }, "stdinBase64"],
      [{ cmd: "x", timeoutMs: -1 }, "timeoutMs"],
      [{ cmd: "x", maxOutputBytes: 1.5 }, "maxOutputBytes"],
      [{ cmd: "x", cwd: "rel" }, "cwd"],
      [{ cmd: "x", env: ["A"] }, "env"],
      [{ cmd: "x", env: { A: 1 } }, "env.A"],
      [[], "object"],
    ] as const
  ) {
    assertThrows(() => parseExecRequest(body), PathError, field);
  }
});

function api(options: { token?: string; origin?: string } = {}) {
  const fake = fakeHost();
  const token = options.token ?? "t0k3n";
  const origin = options.origin ?? "http://127.0.0.1:4321";
  const desktop = createDesktopApi({
    host: fake.host,
    token,
    origin,
    bootMs: 1200,
    pollMs: 1,
    sweepMs: 0,
  });
  const request = (
    path: string,
    init: RequestInit & { auth?: boolean } = {},
  ) => {
    const headers = new Headers(init.headers);
    if (init.auth !== false) headers.set("authorization", `Bearer ${token}`);
    return desktop.handle(
      new Request(`${origin}${path}`, { ...init, headers }),
    )!;
  };
  return { desktop, fake, request, token, origin };
}

Deno.test("/api/* wants the bearer token and, if there is an Origin, the launcher's own", async () => {
  const { request, desktop, origin } = api();
  assertEquals(desktop.handle(new Request(`${origin}/index.html`)), undefined);
  let response = await request("/api/status", { auth: false });
  assertEquals(response.status, 401);
  assertEquals((await response.json()).code, "Unauthorized");
  response = await request("/api/status", {
    auth: false,
    headers: { authorization: "Bearer nope" },
  });
  assertEquals(response.status, 401);
  response = await request("/api/status", {
    headers: { origin: "http://evil.example" },
  });
  assertEquals(response.status, 403);
  response = await request("/api/status", {
    headers: { "sec-fetch-site": "cross-site" },
  });
  assertEquals(response.status, 403);
  response = await request("/api/status", { headers: { origin } });
  assertEquals(response.status, 200);
  const status = await response.json();
  assertEquals(status.native, true);
  assertEquals(status.bootMs, 1200);
  assertEquals(status.executions, { active: 0, limit: 16 });
  response = await request("/api/status");
  assertEquals(response.status, 200);
  await response.body?.cancel();
  response = await request("/api/nothing");
  assertEquals(response.status, 404);
  assertEquals((await response.json()).code, "NoSuchRoute");
});

Deno.test("/api/executions runs a command through the host and reports it once", async () => {
  const { request, fake } = api();
  let response = await request("/api/executions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cmd: "tr a-z A-Z", stdin: "hi", env: { A: "1" } }),
  });
  assertEquals(response.status, 201);
  const { id } = await response.json();
  assertEquals(typeof id, "string");
  assertEquals(
    fake.commands[0].startsWith("exec env 'A=1' sh -c 'tr a-z A-Z' > "),
    true,
    fake.commands[0],
  );
  response = await request(`/api/executions/${id}?wait=1`);
  assertEquals(response.status, 200);
  const result = await response.json();
  assertEquals(result.code, 0);
  assertEquals(result.stdout, "HI");
  assertEquals(result.stdoutTruncated, false);
  // Read once: gone from the list and a 404 after.
  response = await request("/api/executions");
  assertEquals(await response.json(), []);
  response = await request(`/api/executions/${id}`);
  assertEquals(response.status, 404);
  assertEquals((await response.json()).code, "NoSuchExecution");
  // A bad body names its field.
  response = await request("/api/executions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cmd: "x", timeoutMs: "soon" }),
  });
  assertEquals(response.status, 400);
  assertEquals((await response.json()).error.includes("timeoutMs"), true);
  response = await request("/api/executions", {
    method: "POST",
    body: "not json",
  });
  assertEquals(response.status, 400);
  await response.body?.cancel();
  // A kill of nothing is a 404, not a crash.
  response = await request("/api/executions/x99-1", { method: "DELETE" });
  assertEquals(response.status, 404);
  await response.body?.cancel();
  await swept();
});

Deno.test("/api/fs moves bytes as bytes and lists through the guest", async () => {
  const { request, fake } = api();
  // The fake guest's "commands" cannot really write a file; what is
  // checked is the shape of what the launcher asks for.
  let response = await request("/api/fs/content?path=/home/user/a.bin", {
    method: "PUT",
    headers: { "x-yurt-mode": "600" },
    body: new Uint8Array([0, 255, 10]),
  });
  assertEquals(response.status, 204);
  const write = fake.commands.find((c) => c.includes("mv -f --"))!;
  assertEquals(write.includes("chmod 600 -- "), true, write);
  response = await request("/api/fs/content?path=relative", {
    method: "PUT",
    body: "x",
  });
  assertEquals(response.status, 400);
  assertEquals((await response.json()).code, "BadPath");
  response = await request("/api/fs/content?path=/x", {
    method: "PUT",
    headers: { "x-yurt-mode": "rw" },
    body: "x",
  });
  assertEquals(response.status, 400);
  await response.body?.cancel();
  response = await request("/api/fs/entries");
  assertEquals(response.status, 400);
  await response.body?.cancel();
  await swept();
});
