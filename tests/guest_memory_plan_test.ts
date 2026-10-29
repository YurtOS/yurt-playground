import { assert, assertEquals } from "@std/assert";
import {
  plannedPlaygroundHostState,
  playgroundHostState,
} from "../src/boot.ts";
import {
  GUEST_MEMORY_RESERVATION_BYTES,
  KERNEL_MEMORY_RESERVATION_BYTES,
  MIN_GUEST_MEMORY_RESERVATION_BYTES,
  planGuestMemory,
  PROBE_LIMIT_BYTES,
  PROBE_SCRIPT_PATH,
  PROBE_UNIT_BYTES,
  probeAvailableBytes,
  type ProbeWorker,
  RESERVATION_HEADROOM_BYTES,
  reservationForAvailableBytes,
  spawnProbeWorker,
  UNPROBED_RESERVATION_BYTES,
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
      () => planGuestMemory(() => Promise.resolve(IOS_EMPTY_TAB_BYTES)),
    );
    const reservation = state.guestMemoryReservationBytes;
    assert(reservation !== undefined, ua);
    assert(
      fit(IOS_EMPTY_TAB_BYTES - RESERVATION_HEADROOM_BYTES, reservation) >=
        WANTED_PROCESSES,
      `${ua}: ${reservation / MIB} MiB`,
    );
    // And still one ipykernel (81 MiB) and a NumPy-sized cell run in.
    assert(reservation >= 96 * MIB, `${ua}: ${reservation / MIB} MiB`);
  }
  // The desktop reservation is what failed there.
  assert(
    fit(
      IOS_EMPTY_TAB_BYTES - RESERVATION_HEADROOM_BYTES,
      GUEST_MEMORY_RESERVATION_BYTES,
    ) < WANTED_PROCESSES,
  );
  // The floor is what CPython needs here.
  assertEquals(MIN_GUEST_MEMORY_RESERVATION_BYTES, 128 * MIB);
});

Deno.test("a desktop Safari tab keeps the quarter-GiB reservation", async () => {
  // macOS WebKit reserves about 30 GiB; the probe stops at its limit.
  const state = await plannedPlaygroundHostState(
    IPAD_DESKTOP_UA,
    () => planGuestMemory(() => Promise.resolve(PROBE_LIMIT_BYTES)),
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

Deno.test("the reservation is the desktop's quarter GiB when it fits, else the 128 MiB floor", () => {
  const overhead = KERNEL_MEMORY_RESERVATION_BYTES + RESERVATION_HEADROOM_BYTES;
  const exact = overhead + WANTED_PROCESSES * GUEST_MEMORY_RESERVATION_BYTES;
  assertEquals(
    reservationForAvailableBytes(exact).reservationBytes,
    GUEST_MEMORY_RESERVATION_BYTES,
  );
  assertEquals(
    reservationForAvailableBytes(exact - PROBE_UNIT_BYTES).reservationBytes,
    MIN_GUEST_MEMORY_RESERVATION_BYTES,
  );
  // An under-count never goes below the floor (#270 round 2): a probe whose
  // every allocation failed, or one that ran while a disposed kernel's 1 GiB
  // was not yet collected (an empty iOS tab less that 1 GiB).
  for (
    const available of [
      0,
      IOS_EMPTY_TAB_BYTES - KERNEL_MEMORY_RESERVATION_BYTES,
      overhead + 3 * 32 * MIB,
    ]
  ) {
    assertEquals(
      reservationForAvailableBytes(available).reservationBytes,
      MIN_GUEST_MEMORY_RESERVATION_BYTES,
      String(available / MIB),
    );
  }
  // And says how few fit.
  assertEquals(reservationForAvailableBytes(0).processes, 0);
  assertEquals(
    reservationForAvailableBytes(overhead + 3 * 128 * MIB).processes,
    3,
  );
  // The probe counts far enough to show the largest fits.
  assertEquals(
    reservationForAvailableBytes(PROBE_LIMIT_BYTES).reservationBytes,
    GUEST_MEMORY_RESERVATION_BYTES,
  );
  assertEquals(PROBE_LIMIT_BYTES % PROBE_UNIT_BYTES, 0);
});

Deno.test("without a probe every JavaScriptCore page gets what fits on iOS", async () => {
  // A Worker cannot tell an iPad (Mac user agent, no maxTouchPoints in
  // WorkerNavigator) from a Mac, so the fallback is the same everywhere.
  const none = () => Promise.resolve(undefined);
  assertEquals(
    (await planGuestMemory(none)).reservationBytes,
    UNPROBED_RESERVATION_BYTES,
  );
  const fails = () => Promise.reject(new Error("no Worker"));
  assertEquals(
    (await planGuestMemory(fails)).reservationBytes,
    UNPROBED_RESERVATION_BYTES,
  );
  // It is what an empty iOS tab gets measured, and it fits there.
  assertEquals(
    reservationForAvailableBytes(IOS_EMPTY_TAB_BYTES).reservationBytes,
    UNPROBED_RESERVATION_BYTES,
  );
  // Through the planned host state too, with the iPad's Mac user agent.
  const state = await plannedPlaygroundHostState(
    IPAD_DESKTOP_UA,
    () => planGuestMemory(none),
  );
  assertEquals(
    state.guestMemoryReservationBytes,
    UNPROBED_RESERVATION_BYTES,
  );
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
    await probeAvailableBytes(fakeWorker(undefined, silent), {
      timeoutMs: 5,
      settleMs: 0,
    }),
    undefined,
  );
  assertEquals(silent.at(-1), "terminate");

  const garbled: string[] = [];
  assertEquals(
    await probeAvailableBytes(fakeWorker({ nope: 1 }, garbled), {
      settleMs: 0,
    }),
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

Deno.test("every probe that started a Worker waits before the kernel reserves", async () => {
  const time = async (spawn: () => ProbeWorker) => {
    const started = performance.now();
    await probeAvailableBytes(spawn, { settleMs: 200, timeoutMs: 20 });
    return performance.now() - started;
  };
  // Refused at the cap, stopped at the limit, or timed out mid-reserve.
  for (
    const answer of [
      { totalMiB: 64, firstError: "RangeError: Out of memory" },
      { totalMiB: PROBE_LIMIT_BYTES / MIB, firstError: "" },
      { nope: 1 },
      undefined,
    ]
  ) {
    assert(await time(fakeWorker(answer, [])) >= 190, JSON.stringify(answer));
  }
  // No Worker at all: nothing was reserved, nothing to wait for.
  assert(
    await time(() => {
      throw new Error("no Worker here");
    }) < 150,
  );
});

Deno.test("the probe Worker is the engine's own, not a coordinator's guest proxy", async () => {
  // A coordinator replaces self.Worker with a page-backed proxy after the
  // modules load (installCoordinatorWorkerProxy); the probe must not use it.
  const original = globalThis.Worker;
  globalThis.Worker = class {
    constructor() {
      throw new Error("the guest proxy");
    }
  } as unknown as typeof Worker;
  try {
    const bytes = await probeAvailableBytes(
      () =>
        spawnProbeWorker(
          new URL(`../public${PROBE_SCRIPT_PATH}`, import.meta.url),
        ),
      { settleMs: 0 },
    );
    assert(bytes !== undefined && bytes >= PROBE_UNIT_BYTES, String(bytes));
  } finally {
    globalThis.Worker = original;
  }
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
  assertEquals(PROBE_SCRIPT_PATH, "/memory-probe.js");
  assert(build.includes(`"${PROBE_SCRIPT_PATH.slice(1)}"`));
  const page = Deno.readTextFileSync(
    new URL("../public/memory-probe.html", import.meta.url),
  );
  assert(page.includes('src="./memory-probe.js"'));
});
