import { assert, assertEquals } from "@std/assert";
import {
  probePython,
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

Deno.test("the probe reads python3's presence from command -v's exit", async () => {
  assertEquals(await probePython(fakeSpawner(exit(0)).spawn), true);
  // BusyBox ash's `command -v` of a missing name exits 127.
  assertEquals(await probePython(fakeSpawner(exit(127)).spawn), false);
  assertEquals(await probePython(fakeSpawner(1).spawn), false);
  const { spawn, lines } = fakeSpawner(0);
  await probePython(spawn);
  assertEquals(lines, [PYTHON_PROBE_LINE]);
  assert(PYTHON_PROBE_LINE.includes("command -v python3"));
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
  const session = fakeSession(fakeSpawner(exit(127)).spawn);
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
  assertEquals(posted, [{ type: "error", message: "not crossOriginIsolated" }]);
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
