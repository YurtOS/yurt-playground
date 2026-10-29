import { assertEquals } from "@std/assert";
import {
  type CaptureMark,
  DOWNLOAD_URL_KEEP_MS,
  finishCapture,
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
  markBootEnded(error, true, "snapshot capture failed: compileall exited 1");
  assertEquals(error, {
    snapshotCapture: "failed",
    snapshotCaptureError: "snapshot capture failed: compileall exited 1",
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
  markBootEnded(mark, true, "compileall exited 1");
  markBootEnded(mark, true, "coordinator worker failed");
  markBootEnded(mark, true);
  assertEquals(mark, {
    snapshotCapture: "failed",
    snapshotCaptureError: "compileall exited 1",
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
  markBootEnded(mark, true, "compileall exited 1");
  assertEquals(mark.snapshotCaptureError, "compileall exited 1");
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
async function precompile(paths: { stdlib: string; purelib: string }) {
  const fake = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      `${fake}/sysconfig.py`,
      `def get_path(name):\n    return ${JSON.stringify(paths)}[name]\n`,
    );
    // -S: no site, which would import the real sysconfig first.
    const out = await new Deno.Command("sh", {
      args: ["-c", precompileLine("python3 -S")],
      env: { PYTHONPATH: fake, PYTHONDONTWRITEBYTECODE: "" },
      stdout: "piped",
      stderr: "piped",
    }).output();
    return { code: out.code, stderr: new TextDecoder().decode(out.stderr) };
  } finally {
    await Deno.remove(fake, { recursive: true });
  }
}

Deno.test("a capture compiles the interpreter's own library directories, and fails without them", async () => {
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
    // Another minor version's path: nothing there to compile.
    const none = await precompile({
      stdlib: `${lib}/python3.15`,
      purelib: `${lib}/python3.15/site-packages`,
    });
    assertEquals(none.code, 1);
    assertEquals(
      none.stderr.includes("no Python library directory to compile"),
      true,
      none.stderr,
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
