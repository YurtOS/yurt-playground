import { assertEquals, assertRejects } from "@std/assert";
import { runQueue } from "../src/run_queue.ts";

Deno.test("queued runs never overlap, in call order, and a failure does not stop the queue", async () => {
  const queue = runQueue();
  const log: string[] = [];
  let running = 0;
  const job = (name: string, fail = false) => async () => {
    running++;
    log.push(`start ${name} (${running} running)`);
    await new Promise((resolve) => setTimeout(resolve, 5));
    running--;
    log.push(`end ${name}`);
    if (fail) throw new Error(name);
    return name;
  };
  const a = queue(job("panel"));
  const b = queue(job("python", true));
  const c = queue(job("panel again"));
  assertEquals(await a, "panel");
  await assertRejects(() => b, Error, "python");
  assertEquals(await c, "panel again");
  assertEquals(log, [
    "start panel (1 running)",
    "end panel",
    "start python (1 running)",
    "end python",
    "start panel again (1 running)",
    "end panel again",
  ]);
});
