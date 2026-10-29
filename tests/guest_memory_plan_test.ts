import { assert, assertEquals } from "@std/assert";
import {
  plannedPlaygroundHostState,
  playgroundHostState,
} from "../src/boot.ts";
import {
  GUEST_MEMORY_RESERVATION_BYTES,
  isMobileDevice,
  KERNEL_MEMORY_RESERVATION_BYTES,
  MIN_GUEST_MEMORY_RESERVATION_BYTES,
  planGuestMemory,
  PROBE_LIMIT_BYTES,
  PROBE_UNIT_BYTES,
  probeAvailableBytes,
  type ProbeWorker,
  RESERVATION_HEADROOM_BYTES,
  reservationForAvailableBytes,
  WANTED_PROCESSES,
} from "../src/guest_memory_reservation.ts";

const MIB = 1024 * 1024;

// The real devices of #270 (public/memory-probe.html, 2026-10-29).
const IPAD_UA =
  "Mozilla/5.0 (iPad; CPU OS 18_7 like Mac OS X) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/26.6.1 Mobile/15E148 Safari/604.1";
const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) " +
  "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6.1 " +
  "Mobile/15E148 Safari/604.1";
/** Chrome on iOS 26.6.2: WebKit underneath, the same ~4 GiB cap. */
const IOS_CHROME_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 26_6_2 like Mac OS X) " +
  "AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/156.0.8078.54 " +
  "Mobile/15E148 Safari/604.1";
/** iPadOS's "Request Desktop Website" default: a Mac UA. */
const IPAD_DESKTOP_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/26.6.1 Safari/605.1.15";
const CHROME_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

/** What the iPad and iPhone could reserve in small memories, in an empty
 *  tab: 64 x 64 MiB and 63 x 64 MiB. */
const IOS_EMPTY_TAB_BYTES = 4032 * MIB;
/** How many guest memories of `reservation` fit beside the kernel. */
const fit = (available: number, reservation: number) =>
  Math.floor((available - KERNEL_MEMORY_RESERVATION_BYTES) / reservation);

Deno.test("on an iPad or iPhone the guests leave room for a Packages install beside the kernel", async () => {
  // #270: a quarter GiB per process left room for fewer than a dozen
  // processes beside the kernel's 1 GiB, and the page's own buffers took
  // the rest, so sudo could not exec mkdir (ENOMEM) and sh could not fork.
  for (const ua of [IPAD_UA, IPHONE_UA, IOS_CHROME_UA, IPAD_DESKTOP_UA]) {
    const state = await plannedPlaygroundHostState(
      ua,
      () => planGuestMemory(() => Promise.resolve(IOS_EMPTY_TAB_BYTES), true),
    );
    const reservation = state.guestMemoryReservationBytes;
    assert(reservation !== undefined, ua);
    assert(
      fit(IOS_EMPTY_TAB_BYTES - RESERVATION_HEADROOM_BYTES, reservation) >=
        WANTED_PROCESSES,
      `${ua}: ${reservation / MIB} MiB`,
    );
    // Still a size CPython runs in (an idle one takes about 21 MiB).
    assert(reservation >= MIN_GUEST_MEMORY_RESERVATION_BYTES);
  }
  // The desktop reservation is what failed there.
  assert(fit(IOS_EMPTY_TAB_BYTES, GUEST_MEMORY_RESERVATION_BYTES) < 12);
});

Deno.test("a desktop Safari tab keeps the quarter-GiB reservation", async () => {
  // macOS WebKit reserves about 30 GiB; the probe stops at its limit.
  const state = await plannedPlaygroundHostState(
    IPAD_DESKTOP_UA,
    () => planGuestMemory(() => Promise.resolve(PROBE_LIMIT_BYTES), false),
  );
  assertEquals(
    state.guestMemoryReservationBytes,
    GUEST_MEMORY_RESERVATION_BYTES,
  );
});

Deno.test("V8 and SpiderMonkey never probe and keep the whole sandbox budget", async () => {
  let probed = false;
  const state = await plannedPlaygroundHostState(CHROME_UA, () => {
    probed = true;
    return Promise.resolve({ reservationBytes: 32 * MIB });
  });
  assertEquals(probed, false);
  assertEquals(state, playgroundHostState(CHROME_UA));
  assertEquals(state.guestMemoryReservationBytes, undefined);
});

Deno.test("the reservation steps down by halves to fit the wanted processes", () => {
  const overhead = KERNEL_MEMORY_RESERVATION_BYTES + RESERVATION_HEADROOM_BYTES;
  for (const mib of [256, 128, 64, 32]) {
    const exact = overhead + WANTED_PROCESSES * mib * MIB;
    assertEquals(
      reservationForAvailableBytes(exact).reservationBytes,
      mib * MIB,
    );
    if (mib < 256) {
      assertEquals(
        reservationForAvailableBytes(exact * 2 - overhead).reservationBytes,
        mib * 2 * MIB,
      );
    }
    if (mib > 32) {
      assertEquals(
        reservationForAvailableBytes(exact - 1).reservationBytes,
        (mib / 2) * MIB,
      );
    }
  }
  // Too little for even the smallest: the smallest, and says how few fit.
  const tight = reservationForAvailableBytes(overhead + 3 * 32 * MIB);
  assertEquals(tight.reservationBytes, 32 * MIB);
  assertEquals(tight.processes, 3);
  assertEquals(reservationForAvailableBytes(0).processes, 0);
  // The probe counts far enough to show the largest fits.
  assertEquals(
    reservationForAvailableBytes(PROBE_LIMIT_BYTES).reservationBytes,
    GUEST_MEMORY_RESERVATION_BYTES,
  );
  assertEquals(PROBE_LIMIT_BYTES % PROBE_UNIT_BYTES, 0);
});

Deno.test("without a probe, a phone or tablet gets 64 MiB and a desktop a quarter GiB", async () => {
  const none = () => Promise.resolve(undefined);
  assertEquals((await planGuestMemory(none, true)).reservationBytes, 64 * MIB);
  assertEquals(
    (await planGuestMemory(none, false)).reservationBytes,
    GUEST_MEMORY_RESERVATION_BYTES,
  );
  const fails = () => Promise.reject(new Error("no Worker"));
  assertEquals((await planGuestMemory(fails, true)).reservationBytes, 64 * MIB);
  // 64 MiB fits the wanted processes in an empty iOS tab.
  assert(
    fit(IOS_EMPTY_TAB_BYTES - RESERVATION_HEADROOM_BYTES, 64 * MIB) >=
      WANTED_PROCESSES,
  );
});

Deno.test("iPadOS counts as a phone or tablet with either user agent", () => {
  assert(isMobileDevice(IPAD_UA, 5));
  assert(isMobileDevice(IPHONE_UA, 5));
  assert(isMobileDevice(IOS_CHROME_UA, 5));
  assert(isMobileDevice(IPAD_DESKTOP_UA, 5));
  assert(!isMobileDevice(IPAD_DESKTOP_UA, 0));
  assert(!isMobileDevice(CHROME_UA, 0));
  assert(!isMobileDevice(undefined, 5));
});

/** A probe Worker that answers `answer` (or never, for `undefined`). */
function fakeWorker(answer: unknown, log: string[]): () => ProbeWorker {
  return () => {
    const worker: ProbeWorker = {
      onmessage: null,
      onerror: null,
      postMessage(message) {
        log.push(`post ${JSON.stringify(message)}`);
        if (answer !== undefined) {
          queueMicrotask(() => worker.onmessage?.({ data: answer }));
        }
      },
      terminate() {
        log.push("terminate");
      },
    };
    return worker;
  };
}

Deno.test("the probe counts 32 MiB memories up to its limit and always terminates its Worker", async () => {
  const log: string[] = [];
  const bytes = await probeAvailableBytes(
    fakeWorker(
      { totalMiB: 4032, firstError: "RangeError: Out of memory" },
      log,
    ),
    { settleMs: 1 },
  );
  assertEquals(bytes, 4032 * MIB);
  assertEquals(log, [
    `post ${
      JSON.stringify({
        sizes: [32],
        limit: PROBE_LIMIT_BYTES / PROBE_UNIT_BYTES,
      })
    }`,
    "terminate",
  ]);

  const silent: string[] = [];
  assertEquals(
    await probeAvailableBytes(fakeWorker(undefined, silent), { timeoutMs: 5 }),
    undefined,
  );
  assertEquals(silent.at(-1), "terminate");

  const garbled: string[] = [];
  assertEquals(
    await probeAvailableBytes(fakeWorker({ nope: 1 }, garbled)),
    undefined,
  );
  assertEquals(garbled.at(-1), "terminate");

  assertEquals(
    await probeAvailableBytes(() => {
      throw new Error("no Worker here");
    }),
    undefined,
  );
});

Deno.test("a probe that reached the cap waits before the kernel reserves", async () => {
  const time = async (firstError: string) => {
    const started = performance.now();
    await probeAvailableBytes(
      fakeWorker({ totalMiB: 64, firstError }, []),
      { settleMs: 200 },
    );
    return performance.now() - started;
  };
  assert(await time("RangeError: Out of memory") >= 190);
  assert(await time("") < 150);
});

Deno.test("public/memory-probe.js answers the probe's message as a Worker", async () => {
  // The same script is the diagnostic page and the boot probe.
  const worker = new Worker(
    new URL("../public/memory-probe.js", import.meta.url),
    { type: "module" },
  );
  try {
    const answer = await new Promise<{ totalMiB: number; held: number }>(
      (resolve, reject) => {
        worker.onmessage = (event) => resolve(event.data);
        worker.onerror = (event) => reject(event.message);
        worker.postMessage({ sizes: [PROBE_UNIT_BYTES / MIB], limit: 3 });
      },
    );
    assertEquals(answer.totalMiB, 3 * PROBE_UNIT_BYTES / MIB);
    assertEquals(answer.held, 3);
  } finally {
    worker.terminate();
  }
});

Deno.test("the static site ships the probe script at the path boot asks for", () => {
  const build = Deno.readTextFileSync(
    new URL("../scripts/build-static.ts", import.meta.url),
  );
  assert(build.includes('"memory-probe.js"'));
  const page = Deno.readTextFileSync(
    new URL("../public/memory-probe.html", import.meta.url),
  );
  assert(page.includes('src="./memory-probe.js"'));
});
