import { assertEquals } from "@std/assert";
import { directGuestPort } from "../src/guest_port_policy.ts";

const SAFARI_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/26.6.2 Safari/605.1.15";
const CHROME_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const FIREFOX_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14.0; rv:140.0) " +
  "Gecko/20100101 Firefox/140.0";
const WITH_3115 = { guestMemoryMaximumPages: () => 0 };
const WITHOUT_3115 = {};
const MIB = 1024 * 1024;

Deno.test("Chromium and Firefox always get the direct port", () => {
  for (const userAgent of [CHROME_UA, FIREFOX_UA]) {
    assertEquals(directGuestPort({ userAgent, kernel: WITHOUT_3115 }), true);
  }
});

Deno.test("Safari keeps the relay until a per-process reservation is in effect", () => {
  // With 1 GiB reservations the direct port measured worse than the relay
  // in Safari (yurt-playground#181), so it needs both halves: a kernel
  // that honours the reservation (yurtos-kernel#3115) and a playground
  // that sets one (#179).
  assertEquals(
    directGuestPort({ userAgent: SAFARI_UA, kernel: WITHOUT_3115 }),
    false,
  );
  assertEquals(
    directGuestPort({
      userAgent: SAFARI_UA,
      kernel: WITHOUT_3115,
      reservationBytes: 256 * MIB,
    }),
    false,
    "a kernel without #3115 ignores the reservation",
  );
  assertEquals(
    directGuestPort({ userAgent: SAFARI_UA, kernel: WITH_3115 }),
    false,
    "no reservation set",
  );
  assertEquals(
    directGuestPort({
      userAgent: SAFARI_UA,
      kernel: WITH_3115,
      reservationBytes: 256 * MIB,
    }),
    true,
  );
});

Deno.test("as wired on this branch (no reservation passed), Safari relays", () => {
  // The coordinators call directGuestPort() with no reservation until #179
  // supplies one, so whatever kernel is bundled, Safari keeps the relay.
  assertEquals(directGuestPort({ userAgent: SAFARI_UA }), false);
});
