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
 * announces a URL whose /status answers, and exits when its stdin closes.
 * FAKE_HOST_MODE=fail: a boot that fails. */
const FAKE_HOST = `#!/usr/bin/env -S deno run -A
await Deno.writeTextFile(Deno.env.get("FAKE_HOST_PIDFILE"), String(Deno.pid));
if (Deno.env.get("FAKE_HOST_MODE") === "fail") {
  Deno.exit(1);
} else if (Deno.env.get("FAKE_HOST_MODE") === "boot-forever") {
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
  let timer: ReturnType<typeof setTimeout> | undefined;
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
  // src/desktop.ts imports ../artifacts/pins.json (for --version).
  await Deno.mkdir(join(root, "artifacts"));
  await Deno.copyFile(
    join(repoRoot, "artifacts/pins.json"),
    join(root, "artifacts/pins.json"),
  );
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
  /** Its stderr, once it exits; "" unless launched with `stderr`. */
  stderr: Promise<string>;
};

function launch(
  f: Fixture,
  mode = "announce",
  { stderr = false } = {},
): Launcher {
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
    stderr: stderr ? "piped" : "null",
  }).spawn();
  const errText = stderr
    ? new Response(child.stderr).text()
    : Promise.resolve("");
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
    stderr: errText,
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

Deno.test("a launch while another boots says so instead of booting a second sandbox", async () => {
  const f = await fixture();
  const first = launch(f, "boot-forever");
  let second: Launcher | undefined;
  try {
    await first.waitFor(/booting the sandbox/);
    await hostPid(f);
    second = launch(f);
    const status = await within(second.exited, "the second launch to exit");
    assertEquals(status.code, 0);
    assertStringIncludes(
      await second.waitFor(/./),
      `already starting (pid ${first.child.pid})`,
    );
    const hosts = [];
    for await (const entry of Deno.readDir(f.root)) {
      if (entry.name.startsWith("host-")) hosts.push(entry.name);
    }
    assertEquals(hosts.length, 1, "the second launch booted a sandbox");
  } finally {
    await cleanup(f, first, ...(second ? [second] : []));
  }
});

Deno.test("a launcher killed during its boot does not stop the next one", async () => {
  const f = await fixture();
  const killed = launch(f, "boot-forever");
  let next: Launcher | undefined;
  try {
    await killed.waitFor(/booting the sandbox/);
    await hostPid(f);
    killed.child.kill("SIGKILL");
    await killed.exited;
    next = launch(f);
    await next.waitFor(/Close this window/);
    const state = JSON.parse(await Deno.readTextFile(f.stateFile));
    assertEquals(state.pid, next.child.pid);
  } finally {
    await cleanup(f, killed, ...(next ? [next] : []));
  }
});

Deno.test("a launcher whose sandbox fails to boot leaves no state file", async () => {
  const f = await fixture();
  const launcher = launch(f, "fail");
  try {
    const status = await within(launcher.exited, "the launcher to give up");
    assertEquals(status.code, 1);
    const left = await Deno.stat(f.stateFile).then(() => true, () => false);
    assertEquals(left, false, "the boot's claim outlived the launcher");
  } finally {
    await cleanup(f, launcher);
  }
});

Deno.test("launches started together boot one sandbox", async () => {
  const f = await fixture();
  const launchers = Array.from({ length: 6 }, () => launch(f, "boot-forever"));
  try {
    // All but the one that claimed the boot exit, saying it is starting.
    const exits = await within(
      Promise.all(launchers.map((l) =>
        Promise.race([
          l.exited.then(() => "exited"),
          l.waitForUntimed(/booting the sandbox/).then(() => "booting"),
        ]).catch(() => "exited")
      )),
      "every launch to exit or boot",
    );
    await hostPid(f);
    // A second booting launch spawns its host as soon as the first did.
    await new Promise((resolve) => setTimeout(resolve, 500));
    const hosts = [];
    for await (const entry of Deno.readDir(f.root)) {
      if (entry.name.startsWith("host-")) hosts.push(entry.name);
    }
    assertEquals(
      exits.filter((e) => e === "booting").length,
      1,
      "more than one launch booted a sandbox",
    );
    assertEquals(hosts.length, 1, "more than one host started");
  } finally {
    await cleanup(f, ...launchers);
  }
});

Deno.test("a booting record whose pid is alive but holds no claim is stale", async () => {
  // A reused pid: a live process of this user's that is not the launcher
  // which wrote the record. It used to count as "already starting" (by
  // `kill -0`) for up to 180 s, and every launch meanwhile exited 0.
  const { runningLauncher } = await import("../src/desktop.ts");
  const dir = await Deno.makeTempDir({ prefix: "desktop-state-" });
  const stateFile = join(dir, "playground.json");
  const reused = new Deno.Command("sleep", { args: ["30"] }).spawn();
  try {
    await Deno.writeTextFile(
      stateFile,
      JSON.stringify({ pid: reused.pid, startedAt: Date.now() }),
    );
    assertEquals(await runningLauncher(stateFile), null);
    const left = await Deno.stat(stateFile).then(() => true, () => false);
    assertEquals(left, false);
  } finally {
    reused.kill("SIGKILL");
    await reused.status;
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a booting record holds while its claim does, however long the boot", async () => {
  // A boot still in connectDesktopHost after 180 s lost its claim, and the
  // next launch booted a second sandbox.
  const { claimLauncherState, runningLauncher } = await import(
    "../src/desktop.ts"
  );
  const dir = await Deno.makeTempDir({ prefix: "desktop-state-" });
  const stateFile = join(dir, "playground.json");
  // The claim is made by another process, as a launcher's is.
  const holder = new Deno.Command(Deno.execPath(), {
    args: [
      "eval",
      `const { claimLauncherState } = await import(${
        JSON.stringify(new URL("../src/desktop.ts", import.meta.url).href)
      });
      const claim = await claimLauncherState(${JSON.stringify(stateFile)},
        { pid: Deno.pid, startedAt: Date.now() - 600_000 });
      console.log(claim === null ? "lost" : "claimed");
      setInterval(() => claim, 1000);`,
    ],
    stdout: "piped",
    stderr: "inherit",
  }).spawn();
  const lines = holder.stdout.pipeThrough(new TextDecoderStream()).getReader();
  try {
    assertEquals(
      (await within(lines.read(), "the claim")).value?.trim(),
      "claimed",
    );
    assertEquals((await runningLauncher(stateFile))?.pid, holder.pid);
    // Nor can another launch claim it.
    assertEquals(await claimLauncherState(stateFile, { pid: Deno.pid }), null);
    // SIGKILL: nothing of the holder runs to release the lock; the kernel
    // does, and the record is then stale.
    holder.kill("SIGKILL");
    await holder.status;
    assertEquals(await runningLauncher(stateFile), null);
    const left = await Deno.stat(stateFile).then(() => true, () => false);
    assertEquals(left, false);
  } finally {
    try {
      holder.kill("SIGKILL");
    } catch {
      // already gone
    }
    await holder.status;
    await lines.cancel().catch(() => undefined);
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a booting record naming another user's process is stale", async () => {
  const { runningLauncher } = await import("../src/desktop.ts");
  const dir = await Deno.makeTempDir({ prefix: "desktop-state-" });
  const stateFile = join(dir, "playground.json");
  try {
    // pid 1 is alive but not this user's: not a launcher of ours.
    await Deno.writeTextFile(
      stateFile,
      JSON.stringify({ pid: 1, startedAt: Date.now() }),
    );
    assertEquals(await runningLauncher(stateFile), null);
    const left = await Deno.stat(stateFile).then(() => true, () => false);
    assertEquals(left, false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a launcher that cannot write its claim does not boot", async () => {
  // A failed claim write went on to boot with no claim, and later renamed
  // its record over whatever another launch had claimed meanwhile.
  const f = await fixture();
  await Deno.mkdir(dirname(f.stateFile), { mode: 0o500 });
  const launcher = launch(f, "boot-forever", { stderr: true });
  try {
    const status = await within(launcher.exited, "the launcher to give up");
    assertEquals(status.code, 1);
    // Exit 1 for this reason, not any other failure before the boot.
    assertStringIncludes(
      await launcher.stderr,
      `could not write ${f.stateFile}`,
    );
    const hosts = [];
    for await (const entry of Deno.readDir(f.root)) {
      if (entry.name.startsWith("host-")) hosts.push(entry.name);
    }
    assertEquals(hosts.length, 0, "it booted a sandbox with no claim");
  } finally {
    await Deno.chmod(dirname(f.stateFile), 0o700);
    await cleanup(f, launcher);
  }
});

Deno.test("stale cleanup cannot displace a claim acquired during cleanup", async () => {
  const dir = await Deno.makeTempDir({ prefix: "desktop-state-race-" });
  const stateFile = join(dir, "playground.json");
  const moduleUrl = new URL("../src/desktop.ts", import.meta.url).href;
  const claimantFile = join(dir, "claimant.ts");
  const runnerFile = join(dir, "runner.ts");
  const claimant = `
    const { claimLauncherState } = await import(${JSON.stringify(moduleUrl)});
    const claim = await claimLauncherState(Deno.args[0], { pid: Deno.pid });
    console.log(claim === null ? "lost" : "claimed");
    if (claim !== null) setInterval(() => {}, 1000);
  `;
  const runner = `
    const { claimLauncherState, runningLauncher } = await import(${
    JSON.stringify(moduleUrl)
  });
    const stateFile = Deno.args[0];
    const running = await runningLauncher(stateFile);
    if (running !== null) {
      console.log("already");
    } else {
      const claim = await claimLauncherState(stateFile, { pid: Deno.pid });
      console.log(claim === null ? "lost" : "claimed");
      if (claim !== null) setInterval(() => {}, 1000);
    }
  `;
  const probe = `
    const { runningLauncher } = await import(${JSON.stringify(moduleUrl)});
    const stateFile = ${JSON.stringify(stateFile)};
    const claimantFile = ${JSON.stringify(claimantFile)};
    const runnerFile = ${JSON.stringify(runnerFile)};
    await Deno.writeTextFile(stateFile, JSON.stringify({ pid: 99999999 }));
    const rename = Deno.rename;
    const readTextFile = Deno.readTextFile;
    const atRename = Promise.withResolvers();
    const resumeRename = Promise.withResolvers();
    const atRead = Promise.withResolvers();
    const resumeRead = Promise.withResolvers();
    let pausedRename = false;
    let pausedRead = false;
    const children = [];
    Deno.rename = async (from, to) => {
      if (!pausedRename && String(to).endsWith('.stale')) {
        pausedRename = true;
        atRename.resolve();
        await resumeRename.promise;
        await rename(from, to);
      } else {
        await rename(from, to);
      }
    };
    Deno.readTextFile = async (path) => {
      if (!pausedRead && String(path).endsWith('.stale')) {
        pausedRead = true;
        atRead.resolve();
        await resumeRead.promise;
      }
      return await readTextFile(path);
    };
    const startClaim = (script) => {
      const child = new Deno.Command(Deno.execPath(), {
        args: ["run", "-A", script, stateFile],
        stdout: "piped",
        stderr: "piped",
      }).spawn();
      const line = child.stdout.pipeThrough(new TextDecoderStream())
        .getReader().read().then((result) => result.value?.trim() ?? "");
      children.push(child);
      return { child, line };
    };
    try {
      const cleanup = runningLauncher(stateFile);
      await atRename.promise;
      const serialized = await Deno.stat(stateFile + '.lock').then(
        () => true,
        () => false,
      );
      const first = startClaim(runnerFile);
      // The unfixed implementation lets this runner clean the stale record
      // and claim it while the first cleanup is paused. The fix serializes it.
      if (!serialized) await first.line;
      resumeRename.resolve();
      await atRead.promise;
      const second = startClaim(claimantFile);
      // On the unfixed code this claim lands in the empty path before the
      // displaced first claim is either restored or deleted.
      if (!serialized) await second.line;
      resumeRead.resolve();
      const results = await Promise.all([first.line, second.line]);
      await cleanup;
      console.log(JSON.stringify({ claimCount: results.filter((value) => value === "claimed").length }));
    } finally {
      for (const child of children) {
        try { child.kill("SIGKILL"); } catch { /* already exited */ }
        await child.status;
      }
      Deno.rename = rename;
      Deno.readTextFile = readTextFile;
    }
  `;
  const probeFile = join(dir, "probe.ts");
  try {
    await Deno.writeTextFile(claimantFile, claimant);
    await Deno.writeTextFile(runnerFile, runner);
    await Deno.writeTextFile(probeFile, probe);
    const result = await new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", probeFile],
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(result.code, 0, new TextDecoder().decode(result.stderr));
    assertEquals(JSON.parse(new TextDecoder().decode(result.stdout)), {
      claimCount: 1,
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a slow health probe does not discard the live launcher's locked state", async () => {
  const dir = await Deno.makeTempDir({ prefix: "desktop-health-race-" });
  const stateFile = join(dir, "playground.json");
  const moduleUrl = new URL("../src/desktop.ts", import.meta.url).href;
  const probe = `
    const { claimLauncherState, runningLauncher, writeLauncherState } = await import(${
    JSON.stringify(moduleUrl)
  });
    const stateFile = ${JSON.stringify(stateFile)};
    const claim = await claimLauncherState(stateFile, { pid: Deno.pid });
    if (claim === null) throw new Error('could not make launcher claim');
    let fetches = 0;
    globalThis.fetch = async (_input, init) => {
      fetches++;
      return await new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
    };
    try {
      await writeLauncherState(stateFile, { pid: Deno.pid, url: 'http://127.0.0.1:1/' });
      const running = await runningLauncher(stateFile);
      console.log(JSON.stringify({ pid: running?.pid ?? null, fetches }));
    } finally {
      claim.close();
    }
  `;
  const probeFile = join(dir, "probe.ts");
  try {
    await Deno.writeTextFile(probeFile, probe);
    const result = await new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", probeFile],
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(result.code, 0, new TextDecoder().decode(result.stderr));
    assertEquals(JSON.parse(new TextDecoder().decode(result.stdout)), {
      pid: JSON.parse(await Deno.readTextFile(stateFile)).pid,
      fetches: 0,
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
