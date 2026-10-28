import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  installThenLaunch,
  kernelFailureDropsLayer,
  kernelLifecycle,
  probePython,
  PYTHON_MISSING_EXIT,
  PYTHON_PROBE_COMMAND,
  PYTHON_PROBE_LINE,
  type StartReport,
  startSandbox,
} from "../src/coordinator_start.ts";
import type { SpawnedProcess, Spawner, WaitStatus } from "../src/executions.ts";
import type { JupyterTransport } from "../src/jupyter_transport.ts";

/** A spawner whose every process exits with `status` (or never, for
 * `"hang"`), recording the lines it ran. */
function fakeSpawner(status: WaitStatus | number | "hang") {
  const lines: string[] = [];
  const spawn: Spawner = (line) => {
    lines.push(line);
    const process: SpawnedProcess = {
      pid: 7,
      exited: status === "hang"
        ? new Promise<never>(() => {})
        : Promise.resolve(status),
      takeStdout: () => new Uint8Array(),
      takeStderr: () => new Uint8Array(),
    };
    return Promise.resolve(process);
  };
  return { spawn, lines };
}

const exit = (code: number): WaitStatus => ({
  code,
  signal: null,
  coreDumped: false,
});

/** A booted session that counts its stops: none may happen once the shell
 * is up, whatever Jupyter does. */
function fakeSession(process?: Spawner) {
  const session = {
    process,
    stops: 0,
    stop() {
      session.stops++;
    },
  };
  return session;
}

const transport: JupyterTransport = {
  send: () => Promise.resolve(),
  subscribe: () => () => {},
  close: () => Promise.resolve(),
};

Deno.test("only the probe's own exit code says python3 is missing", async () => {
  assertEquals(PYTHON_MISSING_EXIT, 42);
  assertEquals(await probePython(fakeSpawner(exit(0)).spawn), true);
  assertEquals(await probePython(fakeSpawner(exit(42)).spawn), false);
  assertEquals(await probePython(fakeSpawner(42).spawn), false);
  // Any other code is not the probe's answer -- a failed redirect (a full
  // /tmp), a shell that could not run it, a SIGKILL folded to 137, even
  // `command -v`'s own 127 -- so the launch goes ahead as before.
  for (const code of [1, 2, 126, 127, 137]) {
    assertEquals(
      await probePython(fakeSpawner(exit(code)).spawn),
      undefined,
      `exit ${code}`,
    );
    assertEquals(await probePython(fakeSpawner(code).spawn), undefined);
  }
  const { spawn, lines } = fakeSpawner(0);
  await probePython(spawn);
  assertEquals(lines, [PYTHON_PROBE_LINE]);
  assertEquals(
    PYTHON_PROBE_COMMAND,
    "command -v python3 >/dev/null && exit 0; exit 42",
  );
  assertEquals(PYTHON_PROBE_LINE, `exec /bin/sh -c '${PYTHON_PROBE_COMMAND}'`);
});

Deno.test("a probe exit that is not the missing code launches Jupyter on the image", async () => {
  for (const code of [1, 2, 137]) {
    const session = fakeSession(fakeSpawner(exit(code)).spawn);
    const posted: StartReport[] = [];
    let launched = 0;
    await startSandbox({
      boot: () => Promise.resolve(session),
      booted: () => {},
      noJupyter: false,
      startKernel: () => {
        launched++;
        return Promise.resolve(transport);
      },
      post: (report) => posted.push(report),
    });
    assertEquals(launched, 1, `exit ${code}`);
    assertEquals(posted.at(-1), { type: "notebook-ready" });
  }
});

Deno.test("a probe that cannot tell leaves the launch to go ahead", async () => {
  // No process of the page's own (the desktop app's page).
  assertEquals(await probePython(undefined), undefined);
  // Killed by a signal: says nothing about python3.
  assertEquals(
    await probePython(
      fakeSpawner({ code: null, signal: 9, coreDumped: false }).spawn,
    ),
    undefined,
  );
  // Hung: bounded.
  assertEquals(await probePython(fakeSpawner("hang").spawn, 5), undefined);
  // The spawn itself failed.
  assertEquals(
    await probePython(() => Promise.reject(new Error("no slot"))),
    undefined,
  );
});

Deno.test("an image without python3 keeps its shell and gets python-missing, not a Jupyter launch", async () => {
  const session = fakeSession(fakeSpawner(exit(42)).spawn);
  const posted: StartReport[] = [];
  let launched = 0;
  let booted = 0;
  const result = await startSandbox({
    boot: () => Promise.resolve(session),
    booted: () => booted++,
    noJupyter: false,
    startKernel: () => {
      launched++;
      return Promise.resolve(transport);
    },
    post: (report) => posted.push(report),
  });
  assertEquals(result, undefined);
  assertEquals(booted, 1);
  assertEquals(launched, 0, "no ipykernel launch on an image without python3");
  assertEquals(session.stops, 0, "the shell is not stopped");
  assertEquals(posted, [{ type: "python-missing" }]);
});

Deno.test("a Jupyter that does not start is an error next to a shell that stays", async () => {
  const session = fakeSession(fakeSpawner(exit(0)).spawn);
  const posted: StartReport[] = [];
  const result = await startSandbox({
    boot: () => Promise.resolve(session),
    booted: () => {},
    noJupyter: false,
    startKernel: () =>
      Promise.reject(new Error("the Jupyter kernel exited before writing")),
    post: (report) => posted.push(report),
    tickMs: 1,
  });
  assertEquals(result, undefined);
  assertEquals(session.stops, 0, "the shell is not stopped");
  assertEquals(posted.at(0), { type: "status", text: "starting Jupyter" });
  assertEquals(posted.at(-1), {
    type: "error",
    message: "Jupyter did not start: the Jupyter kernel exited before writing",
    endsBoot: true,
  });
});

Deno.test("an image with python3 launches Jupyter as before", async () => {
  const session = fakeSession(fakeSpawner(exit(0)).spawn);
  const posted: StartReport[] = [];
  const order: string[] = [];
  const result = await startSandbox({
    boot: () => Promise.resolve(session),
    booted: () => order.push("booted"),
    launching: () => order.push("launching"),
    noJupyter: false,
    startKernel: (s) => {
      assertEquals(s, session);
      order.push("startKernel");
      return Promise.resolve(transport);
    },
    post: (report) => posted.push(report),
  });
  assertEquals(result, transport);
  assertEquals(order, ["booted", "launching", "startKernel"]);
  assertEquals(posted, [
    { type: "status", text: "starting Jupyter" },
    { type: "notebook-ready" },
  ]);
  assertEquals(session.stops, 0);
});

Deno.test("a session that cannot probe (the desktop app) still launches Jupyter", async () => {
  const posted: StartReport[] = [];
  let launched = 0;
  await startSandbox({
    boot: () => Promise.resolve(fakeSession(undefined)),
    booted: () => {},
    noJupyter: false,
    startKernel: () => {
      launched++;
      return Promise.resolve(transport);
    },
    post: (report) => posted.push(report),
  });
  assertEquals(launched, 1);
  assertEquals(posted.at(-1), { type: "notebook-ready" });
});

Deno.test("a tablet's shell-only session neither probes nor launches", async () => {
  const { spawn, lines } = fakeSpawner(exit(0));
  const posted: StartReport[] = [];
  let launched = 0;
  await startSandbox({
    boot: () => Promise.resolve(fakeSession(spawn)),
    booted: () => {},
    noJupyter: true,
    startKernel: () => {
      launched++;
      return Promise.resolve(transport);
    },
    post: (report) => posted.push(report),
  });
  assertEquals(lines, []);
  assertEquals(launched, 0);
  assertEquals(posted, [{ type: "status", text: "" }, { type: "shell-ready" }]);
});

Deno.test("a boot that fails is posted as the error", async () => {
  const posted: StartReport[] = [];
  let booted = 0;
  await startSandbox({
    boot: () => Promise.reject(new Error("not crossOriginIsolated")),
    booted: () => booted++,
    noJupyter: false,
    startKernel: () => Promise.resolve(transport),
    post: (report) => posted.push(report),
  });
  assertEquals(booted, 0);
  assertEquals(posted, [
    { type: "error", message: "not crossOriginIsolated", endsBoot: true },
  ]);
});

Deno.test("the coordinator worker starts through startSandbox and never stops a session", () => {
  const worker = Deno.readTextFileSync(
    new URL("../src/coordinator_worker.ts", import.meta.url),
  );
  assert(/await startSandbox\(\{/.test(worker), "the worker uses startSandbox");
  assertEquals(
    /\bsession\??\.stop\(/.test(worker),
    false,
    "no session.stop() in the coordinator: a Jupyter failure killed the shell",
  );
});

Deno.test("the slim image: Python is installed, then the kernel starts", async () => {
  const reports: StartReport[] = [];
  const order: string[] = [];
  const started = await startSandbox({
    boot: () => Promise.resolve(fakeSession(fakeSpawner(exit(42)).spawn)),
    booted: () => {},
    noJupyter: false,
    installPython: () => {
      order.push("install");
      return Promise.resolve();
    },
    startKernel: () => {
      order.push("kernel");
      return Promise.resolve(transport);
    },
    post: (report) => reports.push(report),
  });
  assertEquals(started, transport);
  assertEquals(order, ["install", "kernel"]);
  assertEquals(reports.at(-1), { type: "notebook-ready" });
  assertEquals(reports.some((r) => r.type === "python-missing"), false);
});

Deno.test("a failed install is python-missing with its error; the shell stays and no kernel is tried", async () => {
  const reports: StartReport[] = [];
  const session = fakeSession(fakeSpawner(exit(42)).spawn);
  let kernels = 0;
  const started = await startSandbox({
    boot: () => Promise.resolve(session),
    booted: () => {},
    noJupyter: false,
    installPython: () =>
      Promise.reject(new Error("pkg install python failed: x")),
    startKernel: () => {
      kernels++;
      return Promise.resolve(transport);
    },
    post: (report) => reports.push(report),
  });
  assertEquals(started, undefined);
  assertEquals(kernels, 0);
  assertEquals(session.stops, 0);
  assertEquals(reports.at(-1), {
    type: "python-missing",
    error: "pkg install python failed: x",
  });
});

Deno.test("a retry after a failed install starts the kernel once it works", async () => {
  const reports: StartReport[] = [];
  const session = fakeSession(fakeSpawner(exit(42)).spawn);
  let tries = 0;
  const deps = {
    installPython: () =>
      ++tries === 1 ? Promise.reject(new Error("offline")) : Promise.resolve(),
    startKernel: () => Promise.resolve(transport),
    post: (report: StartReport) => reports.push(report),
  };
  assertEquals(await installThenLaunch(session, deps), undefined);
  assertEquals(reports.at(-1), { type: "python-missing", error: "offline" });
  assertEquals(await installThenLaunch(session, deps), transport);
  assertEquals(reports.at(-1), { type: "notebook-ready" });
});

Deno.test("an image with python3 is never installed into", async () => {
  let installs = 0;
  await startSandbox({
    boot: () => Promise.resolve(fakeSession(fakeSpawner(exit(0)).spawn)),
    booted: () => {},
    noJupyter: false,
    installPython: () => {
      installs++;
      return Promise.resolve();
    },
    startKernel: () => Promise.resolve(transport),
    post: () => {},
  });
  assertEquals(installs, 0);
});

Deno.test("a capture seals the installed sandbox instead of launching Jupyter, and its success is no error", async () => {
  const reports: StartReport[] = [];
  const order: string[] = [];
  const started = await startSandbox({
    boot: () => Promise.resolve(fakeSession(fakeSpawner(exit(42)).spawn)),
    booted: () => {},
    noJupyter: false,
    installPython: () => {
      order.push("install");
      return Promise.resolve();
    },
    launching: () => order.push("launching"),
    startKernel: () => {
      order.push("kernel");
      return Promise.resolve(transport);
    },
    capture: () => {
      order.push("capture");
      return Promise.resolve();
    },
    post: (report) => reports.push(report),
  });
  assertEquals(started, undefined);
  assertEquals(order, ["install", "capture"]);
  assertEquals(reports.some((r) => r.type === "error"), false);
  assertEquals(
    reports.some((r) => r.type === "notebook-ready"),
    false,
  );
});

Deno.test("a failed capture is said as one, not as a Jupyter that did not start", async () => {
  const reports: StartReport[] = [];
  await startSandbox({
    boot: () => Promise.resolve(fakeSession(fakeSpawner(exit(42)).spawn)),
    booted: () => {},
    noJupyter: false,
    installPython: () => Promise.resolve(),
    startKernel: () => Promise.resolve(transport),
    capture: () => Promise.reject(new Error("compileall exited 2")),
    post: (report) => reports.push(report),
  });
  assertEquals(reports.at(-1), {
    type: "error",
    message: "snapshot capture failed: compileall exited 2",
    endsBoot: true,
  });
});

Deno.test("a stack-overflow relaunch's note rides on every later 'starting Jupyter' tick", async () => {
  const posted: StartReport[] = [];
  await startSandbox({
    boot: () => Promise.resolve(fakeSession(fakeSpawner(exit(0)).spawn)),
    booted: () => {},
    noJupyter: false,
    startKernel: async (_session, relaunching) => {
      relaunching(2);
      // Long enough for the 1 ms ticker to post again.
      await new Promise((resolve) => setTimeout(resolve, 20));
      return transport;
    },
    post: (report) => posted.push(report),
    tickMs: 1,
  });
  const statuses = posted.flatMap((r) => r.type === "status" ? [r.text] : []);
  const note = "launch 2: the last one overflowed the browser's stack";
  const relaunched = statuses.findIndex((text) => text.includes(note));
  assertEquals(
    statuses[relaunched],
    `starting Jupyter (0 s, ${note})`,
    "said at once, with the count",
  );
  const later = statuses.slice(relaunched + 1);
  assert(later.length > 0, "the ticker posted after the relaunch");
  for (const text of later) {
    assert(
      /^starting Jupyter \(\d+ s, launch 2: the last one overflowed the browser's stack\)$/
        .test(text),
      text,
    );
  }
  assertEquals(posted.at(-1), { type: "notebook-ready" });
});

Deno.test("a kernel failure drops the Python layer, an error that is not one does not", () => {
  assert(
    kernelFailureDropsLayer({
      type: "error",
      message: "Jupyter did not start: the Jupyter kernel exited (exit 1)",
    }),
  );
  assertEquals(
    kernelFailureDropsLayer({ type: "error", message: "Jupyter is not ready" }),
    false,
  );
  assertEquals(kernelFailureDropsLayer({ type: "notebook-ready" }), false);
});

Deno.test("the coordinator worker hands the relaunch note on at start, retry and restart", () => {
  const worker = Deno.readTextFileSync(
    new URL("../src/coordinator_worker.ts", import.meta.url),
  );
  // Start and the Install/retry path: launchKernel's ticker carries it.
  const starts = worker.match(
    /startKernel: \((\w+), relaunching\) =>\s+startGuestKernel\(\1, kernelPorts, \{ relaunching \}\)/g,
  );
  assertEquals(starts?.length, 2, "both startKernel deps forward it");
  assertEquals(
    worker.match(/\bstartGuestKernel\(/g)?.length,
    2,
    "no startGuestKernel call without it",
  );
  // A restart says "restarting", not "starting", with the note.
  assert(
    /restartGuestKernel\(\s*launchSession,\s*previous,\s*kernelPorts,\s*\{\s*relaunching: \(launch\) =>\s*post\(\{\s*type: "status",\s*text: `restarting Jupyter \(\$\{relaunchNote\(launch\)\}\)`,?\s*\}\),?\s*\}/
      .test(worker),
    "the restart forwards its own relaunch status",
  );
  // A stack overflow is the browser's, not the layer's.
  assert(/kernelFailureDropsLayer\(report\)/.test(worker));
});

Deno.test("a Jupyter restart during the boot's start is refused at once; one after a failed start runs", async () => {
  const lifecycle = kernelLifecycle();
  let fail!: (error: Error) => void;
  const start = lifecycle.start(() =>
    new Promise<void>((_resolve, reject) => fail = reject)
  );
  const events: string[] = [];
  const restart = () =>
    lifecycle.restart(
      () => {
        events.push("restarted");
        return Promise.resolve();
      },
      () => events.push("refused"),
    );
  // Not queued behind the start (minutes of ipykernel import and its
  // relaunches, then a restart of the fresh kernel): refused now.
  await restart();
  assertEquals(events, ["refused"]);
  fail(new Error("the boot threw"));
  await assertRejects(() => start, Error, "the boot threw");
  await restart();
  assertEquals(events, ["refused", "restarted"]);
});

Deno.test("a restart or install that throws does not stop the next one", async () => {
  const lifecycle = kernelLifecycle();
  await assertRejects(
    () => lifecycle.enqueue(() => Promise.reject(new Error("install threw"))),
    Error,
    "install threw",
  );
  let ran = false;
  await lifecycle.enqueue(() => {
    ran = true;
    return Promise.resolve();
  });
  assert(ran, "the queue survived the rejection");
});

Deno.test("a restart is refused until every overlapping start has ended", async () => {
  const lifecycle = kernelLifecycle();
  let endBoot!: () => void;
  let endFresh!: () => void;
  const boot = lifecycle.start(() => new Promise((r) => endBoot = r));
  const fresh = lifecycle.start(() => new Promise((r) => endFresh = r));
  let refused = 0;
  let ran = 0;
  const restart = () =>
    lifecycle.restart(() => {
      ran++;
      return Promise.resolve();
    }, () => refused++);
  endBoot();
  await boot;
  await restart();
  assertEquals([refused, ran], [1, 0]);
  endFresh();
  await fresh;
  await restart();
  assertEquals([refused, ran], [1, 1]);
});

Deno.test("a capture whose Python install fails is a failed capture, not python-missing", async () => {
  for (
    const installPython of [
      () => Promise.reject(new Error("pkg install python failed: x")),
      undefined,
    ]
  ) {
    const reports: StartReport[] = [];
    let captured = 0;
    await startSandbox({
      boot: () => Promise.resolve(fakeSession(fakeSpawner(exit(42)).spawn)),
      booted: () => {},
      noJupyter: false,
      installPython,
      startKernel: () => Promise.resolve(transport),
      capture: () => {
        captured++;
        return Promise.resolve();
      },
      post: (report) => reports.push(report),
    });
    assertEquals(captured, 0);
    assertEquals(reports.some((r) => r.type === "python-missing"), false);
    const last = reports.at(-1);
    assertEquals(last?.type === "error" && last.endsBoot, true);
    assert(
      last?.type === "error" &&
        last.message.startsWith("snapshot capture failed: "),
      JSON.stringify(last),
    );
  }
});

Deno.test("the page wires a capture's outcome marks (src/capture_outcome.ts)", () => {
  const page = Deno.readTextFileSync(
    new URL("../src/page.ts", import.meta.url),
  );
  // Every end of the boot reaches the mark, with its reason when known,
  // once; the file goes through finishCapture.
  const endBoot = page.match(
    /const endBoot = \(why\?: string\) => \{([^}]*)\};/,
  );
  assert(endBoot !== null && /endCapture\(why\);/.test(endBoot[1]));
  assert(/if \(msg\.endsBoot === true\) endBoot\(msg\.message\);/.test(page));
  assert(/worker\.onerror = [^]*?endBoot\(message\);/.test(page));
  assertEquals(
    page.match(/endCapture\(/g)?.length,
    2,
    "defined, and called once",
  );
  assert(
    /msg\.type === "snapshot-captured"\) \{\s*finishCapture\(\s*document\.documentElement\.dataset,\s*\(\) => saveSnapshot\(msg\.blob, msg\.ms\),\s*endBoot,\s*fail,/
      .test(page),
  );
  assert(/saveDownload\(\s*\{/.test(page));
  // The worker's own "snapshot captured" status comes before the file, so
  // a failure to save it is the last word in the status line.
  const worker = Deno.readTextFileSync(
    new URL("../src/coordinator_worker.ts", import.meta.url),
  );
  const status = worker.indexOf("text: `snapshot captured (");
  const captured = worker.indexOf('type: "snapshot-captured",');
  assert(status > 0 && captured > status, "status, then the file");
  const script = Deno.readTextFileSync(
    new URL("../scripts/release-snapshot.ts", import.meta.url),
  );
  assert(
    script.includes('dataset.snapshotCapture === "failed"') &&
      !/failed\|error/.test(script),
    "the release script waits on the mark, not on the status text",
  );
});
