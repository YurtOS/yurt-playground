import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { bootPlayground } from "../src/boot.ts";
import {
  fetchViaHandler,
  memoryTerm,
  resolvePlaygroundArtifacts,
  typeCommand,
} from "./ash_harness.ts";
Deno.test({
  name:
    "resident guest exit, stdin EOF and positive-pid signalling preserve another job",
  fn: async () => {
    if (!await resolvePlaygroundArtifacts()) return;
    const term = memoryTerm();
    const session = await bootPlayground({
      isolated: true,
      fetchBytes: fetchViaHandler,
      term,
      show: () => {},
    });
    try {
      assert(session.startResident);
      const input = await session.startResident(
        "exec sh -c 'read ignored; exit 7'",
      );
      assertEquals(await input.exited, 7);
      const other = await session.startResident("exec sleep 60");
      const target = await session.startResident("exec sleep 60");
      assert(target.pid > 0);
      assert(other.pid !== target.pid);
      await assertRejects(() => target.signalPid(0), RangeError);
      await target.signalPid(15);
      await target.exited;
      assertStringIncludes(
        await typeCommand(term, `kill -0 ${other.pid} && echo OTHER_ALIVE`),
        "OTHER_ALIVE",
      );
      await other.signalPid(9);
      await other.exited;
      assertStringIncludes(
        await typeCommand(term, "echo TERMINAL_ALIVE"),
        "TERMINAL_ALIVE",
      );
    } finally {
      session.dispose!();
    }
  },
});
