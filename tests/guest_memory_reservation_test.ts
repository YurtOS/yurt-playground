import { assert, assertEquals } from "@std/assert";
import {
  GUEST_MEMORY_RESERVATION_BYTES,
  playgroundHostState,
} from "../src/boot.ts";

const MIB = 1024 * 1024;

Deno.test("each guest process reserves a quarter GiB, not the whole sandbox budget", () => {
  // yurtos-kernel#2996: Safari holds about 32 GiB of shared wasm memory
  // reservations per tab, and every process used to reserve the 1 GiB
  // sandbox budget, so a burst of a few dozen execs ran it out.
  assertEquals(
    playgroundHostState().guestMemoryReservationBytes,
    GUEST_MEMORY_RESERVATION_BYTES,
  );
  assert(32 * 1024 / (GUEST_MEMORY_RESERVATION_BYTES / MIB) >= 100);
  // Measured peaks: ipykernel 81 MiB, a 2000x2000 NumPy matmul 98 MiB.
  assert(GUEST_MEMORY_RESERVATION_BYTES >= 2 * 98 * MIB);
});

/** Every `KernelHostInterface.load(` / `.restore(` call in `src/`, as
 * `file: call text` up to its closing parenthesis. */
function kernelBuildCalls(): string[] {
  const calls: string[] = [];
  const srcDir = new URL("../src/", import.meta.url);
  for (const entry of Deno.readDirSync(srcDir)) {
    if (!entry.isFile || !entry.name.endsWith(".ts")) continue;
    const text = Deno.readTextFileSync(new URL(entry.name, srcDir));
    for (const m of text.matchAll(/KernelHostInterface\.(load|restore)\(/g)) {
      let depth = 0;
      let end = m.index;
      for (; end < text.length; end++) {
        if (text[end] === "(") depth++;
        if (text[end] === ")" && --depth === 0) break;
      }
      calls.push(`${entry.name}: ${text.slice(m.index, end + 1)}`);
    }
  }
  return calls;
}

Deno.test("every in-browser kernel load and restore reserves the playground's quarter GiB", () => {
  // The kernel applies the reservation wherever it builds a guest memory,
  // restore included: a worker that loads or restores with the default
  // state puts its guests back on the whole sandbox budget.
  const calls = kernelBuildCalls();
  // bootPlayground's load, and a load and a restore in each of the
  // notebook kernel and snapshot workers.
  assert(calls.length >= 5, `found only ${calls.length}:\n${calls.join("\n")}`);
  for (const call of calls) {
    assert(
      /playgroundHostState\(\)\s*,?\s*\)$/.test(call),
      `does not pass playgroundHostState() last: ${call}`,
    );
  }
});
