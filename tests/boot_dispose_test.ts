import { assertRejects } from "@std/assert";
import { bootAshSession } from "./ash_harness.ts";

// Deno's timer sanitizer stays on, so these live in a file of their own: the
// other boot tests end with their exec sweeps pending, and one of those
// completing during a test here would fail it.

Deno.test("dispose cancels the pending output sweep of a finished exec", async () => {
  const session = await bootAshSession();
  if (!session) return;
  try {
    const finished = await session.process("exec true", {
      maxOutputBytes: 64,
    });
    await finished.exited;
  } finally {
    session.dispose();
  }
});

Deno.test("after dispose a process and a seal are refused, a second dispose is a no-op", async () => {
  const session = await bootAshSession();
  if (!session) return;
  session.dispose();
  await assertRejects(
    () => session.process("exec true", { maxOutputBytes: 64 }),
    Error,
    "disposed",
  );
  await assertRejects(() => session.seal(), Error, "disposed");
  session.dispose();
});
