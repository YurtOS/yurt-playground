import { assertEquals } from "@std/assert";
import {
  type CaptureMark,
  DOWNLOAD_URL_KEEP_MS,
  finishCapture,
  markBootEnded,
  markCaptured,
  NO_SNAPSHOT,
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
  markCaptured(captured);
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
  finishCapture(mark, () => {
    throw new Error("quota exceeded");
  }, endBoot);
  assertEquals(ended, ["saving the snapshot failed: quota exceeded"]);
  assertEquals(mark.snapshotCapture, "failed");
  const saved: CaptureMark = {};
  const order: string[] = [];
  finishCapture(saved, () => order.push("save"), (why) => {
    order.push(`end ${saved.snapshotCapture} ${why}`);
  });
  assertEquals(order, ["save", "end captured undefined"]);
});
