import { assertEquals } from "@std/assert";
import {
  directGuestPort,
  playgroundGuestPortIsDirect,
} from "../src/guest_port_policy.ts";

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

Deno.test("the coordinators pass the playground's own reservation, so Safari goes direct on a #3115 kernel", () => {
  // What the three coordinators call. #179 sets a quarter GiB per process
  // on JavaScriptCore only (playgroundHostState); that must reach the
  // policy, or Safari silently stays on the relay.
  assertEquals(
    playgroundGuestPortIsDirect({ userAgent: SAFARI_UA, kernel: WITH_3115 }),
    true,
  );
  assertEquals(
    playgroundGuestPortIsDirect({ userAgent: SAFARI_UA, kernel: WITHOUT_3115 }),
    false,
    "a kernel without #3115 keeps Safari on the relay",
  );
  for (const userAgent of [CHROME_UA, FIREFOX_UA]) {
    assertEquals(
      playgroundGuestPortIsDirect({ userAgent, kernel: WITHOUT_3115 }),
      true,
    );
  }
});

Deno.test("the bundled kernel host honours per-process reservations, so Safari takes the direct port", () => {
  // The kernel the playground pins (artifacts/pins.json) must include
  // yurtos-kernel#3115; a pin that drops it would put Safari back on the
  // relay without anything else turning red.
  assertEquals(playgroundGuestPortIsDirect({ userAgent: SAFARI_UA }), true);
});

Deno.test("every coordinator decides its guests' port with the playground's reservation", async () => {
  // A coordinator that calls installCoordinatorWorkerProxy() bare, or
  // directGuestPort() without the reservation, keeps Safari on the relay
  // however the policy is tested above.
  const src = new URL("../src/", import.meta.url);
  const installers: string[] = [];
  for await (const entry of Deno.readDir(src)) {
    if (!entry.isFile || !entry.name.endsWith(".ts")) continue;
    const text = await Deno.readTextFile(new URL(entry.name, src));
    const calls = [
      ...text.matchAll(/installCoordinatorWorkerProxy\(([^;]*)\);/g),
    ]
      .map((match) => match[1].replace(/\s+/g, ""));
    if (calls.length === 0) continue;
    installers.push(entry.name);
    assertEquals(calls, ["()=>playgroundGuestPortIsDirect()"], entry.name);
  }
  assertEquals(installers.sort(), [
    "coordinator_worker.ts",
    "notebook_kernel_worker.ts",
    "snapshot_worker.ts",
  ]);
});
