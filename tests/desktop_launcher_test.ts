// The launcher as a process (scripts/desktop.ts), against a stand-in
// yurt-desktop-host: what happens to the sandbox and to
// ~/.yurt/playground.json when it is interrupted, killed, or started twice
// (yurt-playground#153).
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** A stand-in host. Like the real one it ignores its stdin until the
 * sandbox is up (FAKE_HOST_MODE=boot-forever: it never is, and its
 * "runtime", a child of its own, boots on regardless of the host), then
 * announces a URL whose /status answers, and exits when its stdin closes. */
const FAKE_HOST = `#!/usr/bin/env -S deno run -A
await Deno.writeTextFile(Deno.env.get("FAKE_HOST_PIDFILE"), String(Deno.pid));
if (Deno.env.get("FAKE_HOST_MODE") === "boot-forever") {
  const runtime = new Deno.Command("sleep", { args: ["60"] }).spawn();
  await Deno.writeTextFile(Deno.env.get("FAKE_RUNTIME_PIDFILE"), String(runtime.pid));
  setInterval(() => {}, 1000);
} else {
  const server = Deno.serve({ port: 0, hostname: "127.0.0.1", onListen() {} }, (req) =>
    new URL(req.url).pathname === "/status"
      ? Response.json({ kernelPorts: [1, 2, 3, 4, 5], bootMs: 1 })
      : new Response("nope", { status: 404 }));
  console.log(\`yurt-desktop-host: http://127.0.0.1:\${server.addr.port}/ abc123\`);
  for await (const _ of Deno.stdin.readable) { /* until EOF */ }
  Deno.exit(0);
}
`;

/** `promise`, or a rejection naming `what` after 15 s: a hang fails the
 * test instead of stalling the suite. */
function within<T>(promise: Promise<T>, what: string): Promise<T> {
  let timer: number | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out: ${what}`)), 15_000);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

type Fixture = { root: string; home: string; stateFile: string };

/** The launcher's layout (scripts/, src/, dist/, runtime/) in a temporary
 * directory, with the stand-in host, and a HOME of its own. */
async function fixture(): Promise<Fixture> {
  const root = await Deno.makeTempDir({ prefix: "desktop-launcher-" });
  await Deno.mkdir(join(root, "scripts"));
  await Deno.copyFile(
    join(repoRoot, "scripts/desktop.ts"),
    join(root, "scripts/desktop.ts"),
  );
  await Deno.symlink(join(repoRoot, "src"), join(root, "src"));
  await Deno.mkdir(join(root, "dist"));
  await Deno.writeTextFile(join(root, "dist/index.html"), "<!doctype html>");
  await Deno.mkdir(join(root, "runtime"));
  const host = join(root, "runtime/yurt-desktop-host");
  await Deno.writeTextFile(host, FAKE_HOST);
  await Deno.chmod(host, 0o755);
  const home = join(root, "home");
  await Deno.mkdir(home);
  return { root, home, stateFile: join(home, ".yurt/playground.json") };
}

type Launcher = {
  child: Deno.ChildProcess;
  /** Resolves with stdout once it matches `pattern`, or rejects at exit. */
  waitFor: (pattern: RegExp) => Promise<string>;
  waitForUntimed: (pattern: RegExp) => Promise<string>;
  exited: Promise<Deno.CommandStatus>;
};

function launch(f: Fixture, mode = "announce"): Launcher {
  const id = crypto.randomUUID();
  const child = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--no-check",
      "-A",
      "--config",
      join(repoRoot, "deno.json"),
      "scripts/desktop.ts",
      "--no-open",
    ],
    cwd: f.root,
    env: {
      HOME: f.home,
      FAKE_HOST_MODE: mode,
      FAKE_HOST_PIDFILE: join(f.root, `host-${id}.pid`),
      FAKE_RUNTIME_PIDFILE: join(f.root, `runtime-${id}.pid`),
    },
    stdout: "piped",
    stderr: "null",
  }).spawn();
  let text = "";
  const waiters: Array<() => void> = [];
  const pump = (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of child.stdout) {
      text += decoder.decode(chunk, { stream: true });
      waiters.splice(0).forEach((wake) => wake());
    }
    waiters.splice(0).forEach((wake) => wake());
  })();
  const exited = pump.then(() => child.status);
  return {
    child,
    exited,
    waitFor(pattern) {
      return within(this.waitForUntimed(pattern), `stdout to match ${pattern}`);
    },
    async waitForUntimed(pattern: RegExp) {
      let done = false;
      exited.then(() => (done = true));
      while (!pattern.test(text)) {
        if (done) throw new Error(`launcher exited; stdout:\n${text}`);
        await Promise.race([
          new Promise<void>((wake) => waiters.push(wake)),
          exited,
        ]);
      }
      return text;
    },
  };
}

/** The pid of the host (or with `prefix` "runtime-", its runtime) a
 * launcher in `f` spawned: the one such pid file there. */
async function hostPid(f: Fixture, prefix = "host-"): Promise<number> {
  for (let i = 0; i < 200; i++) {
    for await (const entry of Deno.readDir(f.root)) {
      if (entry.name.startsWith(prefix)) {
        const text = await Deno.readTextFile(join(f.root, entry.name));
        if (text !== "") return Number(text);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("the host never started");
}

async function alive(pid: number): Promise<boolean> {
  const { success } = await new Deno.Command("kill", {
    args: ["-0", String(pid)],
    stderr: "null",
  }).output();
  return success;
}

/** Whether `pid` is gone within five seconds. */
async function exitsSoon(pid: number): Promise<boolean> {
  for (let i = 0; i < 100; i++) {
    if (!(await alive(pid))) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

async function cleanup(f: Fixture, ...launchers: Launcher[]) {
  for (const l of launchers) {
    try {
      l.child.kill("SIGKILL");
    } catch {
      // already gone
    }
    await l.exited;
  }
  for await (const entry of Deno.readDir(f.root)) {
    if (!entry.name.endsWith(".pid")) continue;
    const pid = Number(await Deno.readTextFile(join(f.root, entry.name)));
    try {
      Deno.kill(pid, "SIGKILL");
    } catch {
      // gone with its launcher
    }
  }
  await Deno.remove(f.root, { recursive: true });
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  Deno.test(`${signal} while the sandbox boots takes the host down with the launcher`, async () => {
    // Ctrl-C during boot left yurt-desktop-host and its runtime (~1 GB)
    // running until the boot finished: the host only watches its stdin
    // once it is up, and a runtime whose host died notices only then.
    const f = await fixture();
    const launcher = launch(f, "boot-forever");
    try {
      await launcher.waitFor(/booting the sandbox/);
      const host = await hostPid(f);
      const runtime = await hostPid(f, "runtime-");
      launcher.child.kill(signal);
      await within(launcher.exited, `the launcher to exit on ${signal}`);
      assert(await exitsSoon(host), "the host outlived the launcher");
      assert(await exitsSoon(runtime), "the runtime outlived the launcher");
    } finally {
      await cleanup(f, launcher);
    }
  });
}

Deno.test("an interrupted launcher removes ~/.yurt/playground.json and stops the host", async () => {
  const f = await fixture();
  const launcher = launch(f);
  try {
    await launcher.waitFor(/Close this window/);
    const host = await hostPid(f);
    const state = JSON.parse(await Deno.readTextFile(f.stateFile));
    assertEquals(state.pid, launcher.child.pid);
    launcher.child.kill("SIGINT");
    await within(launcher.exited, "the launcher to exit on SIGINT");
    assert(await exitsSoon(host), "the host outlived the launcher");
    const left = await Deno.stat(f.stateFile).then(() => true, () => false);
    assertEquals(left, false, "the state file outlived the launcher");
  } finally {
    await cleanup(f, launcher);
  }
});

Deno.test("a second launch points at the running one instead of replacing it", async () => {
  const f = await fixture();
  const first = launch(f);
  let second: Launcher | undefined;
  try {
    const firstOut = await first.waitFor(/Close this window/);
    const url = firstOut.match(/Yurt playground: (\S+)/)![1];
    const before = await Deno.readTextFile(f.stateFile);
    second = launch(f);
    const status = await within(second.exited, "the second launch to exit");
    assertEquals(status.code, 0);
    assertStringIncludes(await second.waitFor(/./), url);
    assertEquals(await Deno.readTextFile(f.stateFile), before);
    const hosts = [];
    for await (const entry of Deno.readDir(f.root)) {
      if (entry.name.startsWith("host-")) hosts.push(entry.name);
    }
    assertEquals(hosts.length, 1, "the second launch booted a sandbox");
  } finally {
    await cleanup(f, first, ...(second ? [second] : []));
  }
});

Deno.test("a state file left by a killed launcher does not stop the next one", async () => {
  const f = await fixture();
  const killed = launch(f);
  let next: Launcher | undefined;
  try {
    await killed.waitFor(/Close this window/);
    killed.child.kill("SIGKILL");
    await killed.exited;
    // SIGKILL cannot be caught: the file stays, naming a dead launcher.
    const stale = JSON.parse(await Deno.readTextFile(f.stateFile));
    assertEquals(stale.pid, killed.child.pid);
    next = launch(f);
    await next.waitFor(/Close this window/);
    const state = JSON.parse(await Deno.readTextFile(f.stateFile));
    assertEquals(state.pid, next.child.pid);
  } finally {
    await cleanup(f, killed, ...(next ? [next] : []));
  }
});
