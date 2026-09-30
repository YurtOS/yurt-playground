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
  const state = playgroundHostState() as {
    guestMemoryReservationBytes?: number;
  };
  assertEquals(
    state.guestMemoryReservationBytes,
    GUEST_MEMORY_RESERVATION_BYTES,
  );
  assert(32 * 1024 / (GUEST_MEMORY_RESERVATION_BYTES / MIB) >= 100);
  // Measured peaks: ipykernel 81 MiB, a 2000x2000 NumPy matmul 98 MiB.
  assert(GUEST_MEMORY_RESERVATION_BYTES >= 2 * 98 * MIB);
});
