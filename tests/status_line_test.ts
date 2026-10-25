import { assertEquals } from "@std/assert";
import { createStatusLine } from "../src/status_line.ts";

/** A status line on a plain object, with timers fired by hand. */
function line() {
  const element = { textContent: "" as string | null };
  const timers = new Map<number, () => void>();
  let next = 0;
  const status = createStatusLine(element, {
    holdMs: 1000,
    setTimer: (run) => {
      timers.set(++next, run);
      return next;
    },
    clearTimer: (timer) => timers.delete(timer as number),
  });
  const fire = () => {
    for (const [id, run] of [...timers]) {
      timers.delete(id);
      run();
    }
  };
  return { element, status, fire, timers };
}

Deno.test("progress shows on the line while nothing holds it", () => {
  const { element, status } = line();
  status.progress("starting Jupyter");
  assertEquals(element.textContent, "starting Jupyter");
  status.progress("starting Jupyter (5 s)");
  assertEquals(element.textContent, "starting Jupyter (5 s)");
});

Deno.test("a failed Download home is not written over by the Jupyter ticker", () => {
  const { element, status, fire } = line();
  status.progress("starting Jupyter (5 s)");
  status.notice("download home failed: export /home/user: exit 1", {
    error: true,
  });
  status.progress("starting Jupyter (10 s)");
  assertEquals(
    element.textContent,
    "download home failed: export /home/user: exit 1",
  );
  // The next outcome replaces it, and then progress may show again.
  status.notice("uploaded notes.txt");
  assertEquals(element.textContent, "uploaded notes.txt");
  status.progress("starting Jupyter (15 s)");
  assertEquals(element.textContent, "uploaded notes.txt");
  fire();
  assertEquals(element.textContent, "starting Jupyter (15 s)");
});

Deno.test("an action's error during boot gives way once the boot settles", () => {
  // A drop on the terminal before the shell is up: the error must not hide
  // the ticker and "running" for good.
  const { element, status } = line();
  status.progress("starting ash");
  status.notice("upload: the sandbox is not running", { error: true });
  status.progress("starting Jupyter (5 s)");
  assertEquals(element.textContent, "upload: the sandbox is not running");
  status.progress("running", { settled: true });
  assertEquals(element.textContent, "running");
  // After the boot, an action's error holds the line again.
  status.notice("download home failed: exit 1", { error: true });
  assertEquals(element.textContent, "download home failed: exit 1");
});

Deno.test("an error hold also ends after the long timeout", () => {
  const { element, status, fire } = line();
  status.progress("starting Jupyter (5 s)");
  status.notice("download home failed: exit 1", { error: true });
  status.progress("starting Jupyter (10 s)");
  fire();
  assertEquals(element.textContent, "starting Jupyter (10 s)");
});

Deno.test("a boot failure takes the line over any notice", () => {
  const { element, status, timers } = line();
  status.notice("uploaded notes.txt");
  status.failure("failed: Jupyter did not start: exited");
  assertEquals(element.textContent, "failed: Jupyter did not start: exited");
  assertEquals(timers.size, 0, "the notice's hold is dropped");
  status.progress("running");
  assertEquals(element.textContent, "running");
});
