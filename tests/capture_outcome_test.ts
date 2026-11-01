import { assertEquals } from "@std/assert";
import {
  type CaptureMark,
  capturePrecompiles,
  captureWarmsGo,
  DOWNLOAD_URL_KEEP_MS,
  finishCapture,
  GO_WARMUP_IMPORTS,
  goWarmupLine,
  markBootEnded,
  NO_SNAPSHOT,
  postCaptured,
  precompileLine,
  saveDownload,
} from "../src/capture_outcome.ts";

Deno.test("in a capture, any end of the boot but the captured file is a failed capture", () => {
  // An error, with its reason.
  const error: CaptureMark = {};
  markBootEnded(error, true);
  markBootEnded(
    error,
    true,
    "snapshot capture failed: precompiling the Python set exited 1",
  );
  assertEquals(error, {
    snapshotCapture: "failed",
    snapshotCaptureError:
      "snapshot capture failed: precompiling the Python set exited 1",
  });
  // shell-ready (a shell-only session): no reason but the generic one.
  const shellOnly: CaptureMark = {};
  markBootEnded(shellOnly, true);
  assertEquals(shellOnly, {
    snapshotCapture: "failed",
    snapshotCaptureError: "the boot ended without a snapshot",
  });
  // The file came first: the boot's end after it is no failure.
  const captured: CaptureMark = {};
  finishCapture(captured, () => {}, () => {}, () => {});
  markBootEnded(captured, true, "late error");
  assertEquals(captured, { snapshotCapture: "captured" });
  // Not a capture: nothing is marked.
  const page: CaptureMark = {};
  markBootEnded(page, false, "Jupyter did not start");
  assertEquals(page, {});
});

Deno.test("a captured file is downloaded, and its URL let go only after the download has it", () => {
  const calls: string[] = [];
  const timers: { run: () => void; ms: number }[] = [];
  saveDownload(
    {
      createObjectURL: () => (calls.push("create"), "blob:x"),
      revokeObjectURL: (url) => calls.push(`revoke ${url}`),
      click: (href, name) => calls.push(`click ${href} ${name}`),
      later: (run, ms) => timers.push({ run, ms }),
    },
    new Blob(["s"]),
    "sandbox.seal.gz",
  );
  assertEquals(calls, ["create", "click blob:x sandbox.seal.gz"]);
  assertEquals(timers.map((t) => t.ms), [DOWNLOAD_URL_KEEP_MS]);
  assertEquals(DOWNLOAD_URL_KEEP_MS >= 30_000, true);
  timers[0].run();
  assertEquals(calls.at(-1), "revoke blob:x");
});

Deno.test("a named reason for a failed capture stays; only the generic one is replaced", () => {
  const mark: CaptureMark = {};
  markBootEnded(mark, true);
  assertEquals(mark.snapshotCaptureError, NO_SNAPSHOT);
  markBootEnded(mark, true, "precompiling the Python set exited 1");
  markBootEnded(mark, true, "coordinator worker failed");
  markBootEnded(mark, true);
  assertEquals(mark, {
    snapshotCapture: "failed",
    snapshotCaptureError: "precompiling the Python set exited 1",
  });
});

Deno.test("a captured file that cannot be saved ends the boot as a failed capture", () => {
  const ended: (string | undefined)[] = [];
  const endBoot = (why?: string) => {
    ended.push(why);
    markBootEnded(mark, true, why);
  };
  const mark: CaptureMark = {};
  const failed: string[] = [];
  finishCapture(
    mark,
    () => {
      throw new Error("quota exceeded");
    },
    endBoot,
    (message) => failed.push(message),
  );
  assertEquals(ended, ["saving the snapshot failed: quota exceeded"]);
  assertEquals(failed, ["saving the snapshot failed: quota exceeded"]);
  assertEquals(mark.snapshotCapture, "failed");
  const saved: CaptureMark = {};
  const order: string[] = [];
  finishCapture(saved, () => order.push("save"), (why) => {
    order.push(`end ${saved.snapshotCapture} ${why}`);
  }, (message) => order.push(`fail ${message}`));
  assertEquals(order, ["save", "end captured undefined"]);
});

Deno.test("an empty reason names nothing: a real one replaces it", () => {
  const mark: CaptureMark = {};
  markBootEnded(mark, true, "");
  assertEquals(mark.snapshotCaptureError, NO_SNAPSHOT);
  markBootEnded(mark, true, "precompiling the Python set exited 1");
  assertEquals(
    mark.snapshotCaptureError,
    "precompiling the Python set exited 1",
  );
  const blank: CaptureMark = { snapshotCaptureError: "" };
  markBootEnded(blank, true, "coordinator worker failed");
  assertEquals(blank.snapshotCaptureError, "coordinator worker failed");
});

Deno.test("the worker posts its 'captured' status before the file, so a save failure has the last word", () => {
  const posted: string[] = [];
  postCaptured(
    (message) =>
      posted.push(message.type === "status" ? message.text : message.type),
    new Blob(["12345"]),
    7,
  );
  assertEquals(posted, [
    "snapshot captured (5 bytes); the sealed sandbox runs no Jupyter",
    "snapshot-captured",
  ]);
});

/** precompileLine's program, run by this machine's python3 with a
 * sysconfig that names `paths`. */
async function precompile(
  paths: { stdlib: string; purelib: string },
  { countWalks = false } = {},
) {
  const fake = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      `${fake}/sysconfig.py`,
      `def get_path(name):\n    return ${JSON.stringify(paths)}[name]\n`,
    );
    if (countWalks) {
      // A compileall that only says which directory it was asked to walk.
      await Deno.writeTextFile(
        `${fake}/compileall.py`,
        "def compile_dir(path, quiet=0):\n    print('walk', path)\n    return True\n",
      );
    }
    // -S: no site, which would import the real sysconfig first.
    const out = await new Deno.Command("sh", {
      args: ["-c", precompileLine("python3 -S")],
      env: { PYTHONPATH: fake, PYTHONDONTWRITEBYTECODE: "" },
      stdout: "piped",
      stderr: "piped",
    }).output();
    return {
      code: out.code,
      stdout: new TextDecoder().decode(out.stdout),
      stderr: new TextDecoder().decode(out.stderr),
    };
  } finally {
    await Deno.remove(fake, { recursive: true });
  }
}

Deno.test("a capture compiles the interpreter's own library directories once each, and fails when one is missing", async () => {
  const lib = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${lib}/site-packages`);
    await Deno.writeTextFile(`${lib}/mod.py`, "x = 1\n");
    await Deno.writeTextFile(`${lib}/site-packages/pkg.py`, "y = 2\n");
    const ok = await precompile({
      stdlib: lib,
      purelib: `${lib}/site-packages`,
    });
    assertEquals(ok.code, 0, ok.stderr);
    const cached = [...Deno.readDirSync(`${lib}/site-packages/__pycache__`)];
    assertEquals(cached.length, 1);
    // The interpreter's stdlib is there; the set's purelib is not.
    const noSet = await precompile({
      stdlib: lib,
      purelib: `${lib}/python3.15/site-packages`,
    });
    assertEquals(noSet.code, 1);
    assertEquals(
      noSet.stderr.includes(
        `a Python library directory to compile is missing: ${lib}/python3.15/site-packages`,
      ),
      true,
      noSet.stderr,
    );
    // A module that does not compile fails it too.
    await Deno.writeTextFile(`${lib}/broken.py`, "def (:\n");
    const broken = await precompile({
      stdlib: lib,
      purelib: `${lib}/site-packages`,
    });
    assertEquals(broken.code, 1);
  } finally {
    await Deno.remove(lib, { recursive: true });
  }
});

Deno.test("a library directory inside another is walked once, with it", async () => {
  const lib = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${lib}/site-packages`);
    await Deno.mkdir(`${lib}-site`);
    const nested = await precompile({
      stdlib: lib,
      purelib: `${lib}/site-packages`,
    }, { countWalks: true });
    assertEquals(nested.stdout, `walk ${lib}\n`, nested.stderr);
    // A sibling whose name only starts the same is its own directory.
    const apart = await precompile({
      stdlib: lib,
      purelib: `${lib}-site`,
    }, { countWalks: true });
    assertEquals(apart.stdout, `walk ${lib}\nwalk ${lib}-site\n`);
  } finally {
    await Deno.remove(lib, { recursive: true });
    await Deno.remove(`${lib}-site`, { recursive: true });
  }
});

Deno.test("a capture precompiles the Python it installed; the phone's has none", () => {
  assertEquals(capturePrecompiles("desktop"), true);
  assertEquals(capturePrecompiles("tablet"), true);
  assertEquals(capturePrecompiles("phone"), false);
  // Go's warms its build cache instead: it holds no Python.
  assertEquals(capturePrecompiles("go"), false);
  assertEquals(captureWarmsGo("go"), true);
  for (const kind of ["desktop", "tablet", "phone"] as const) {
    assertEquals(captureWarmsGo(kind), false);
  }
});

/** goWarmupLine run by this machine's sh, with a fake `go` first on the
 * PATH: it records the build it is asked for and the program it is
 * given, and makes the cache a real build would. */
async function warmUp(
  { goenvCache, buildExit = 0 }: { goenvCache?: string; buildExit?: number } =
    {},
) {
  const dir = await Deno.makeTempDir();
  try {
    const cache = `${dir}/cache`;
    await Deno.mkdir(`${dir}/bin`);
    await Deno.writeTextFile(
      `${dir}/bin/go`,
      `#!/bin/sh
case "$1" in
  env) echo ${goenvCache ?? cache} ;;
  build) echo "$*" > ${dir}/build.args; cp main.go ${dir}/main.go; pwd > ${dir}/build.cwd
    mkdir -p ${cache}; exit ${buildExit} ;;
esac
`,
    );
    await Deno.chmod(`${dir}/bin/go`, 0o755);
    const out = await new Deno.Command("/bin/sh", {
      args: ["-c", goWarmupLine(cache)],
      env: { PATH: `${dir}/bin:${Deno.env.get("PATH")}` },
      stdout: "piped",
      stderr: "piped",
    }).output();
    const read = (name: string) =>
      Deno.readTextFile(`${dir}/${name}`).catch(() => undefined);
    const cwd = (await read("build.cwd"))?.trim();
    return {
      code: out.code,
      args: (await read("build.args"))?.trim(),
      program: await read("main.go"),
      scratchLeft: cwd === undefined
        ? undefined
        : await Deno.stat(cwd).then(() => true, () => false),
    };
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("Go's warm-up builds a program of every warm-up import as a file argument, and leaves only the cache", async () => {
  const run = await warmUp();
  assertEquals(run.code, 0);
  assertEquals(run.args, "build -o warmup main.go");
  for (const name of GO_WARMUP_IMPORTS) {
    assertEquals(run.program?.includes(`"${name}"`), true, name);
  }
  assertEquals(run.scratchLeft, false);
});

Deno.test("Go's warm-up fails when go does, or when go keeps its cache elsewhere", async () => {
  assertEquals((await warmUp({ buildExit: 2 })).code !== 0, true);
  const elsewhere = await warmUp({ goenvCache: "/root/.cache/go-build" });
  assertEquals(elsewhere.code !== 0, true);
  assertEquals(elsewhere.args, undefined, "nothing was built");
});
