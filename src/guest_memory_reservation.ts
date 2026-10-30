/**
 * How much address space each guest process reserves on JavaScriptCore,
 * sized from what this tab can actually reserve (yurt-playground#270).
 *
 * A shared `WebAssembly.Memory` reserves its whole maximum up front, and
 * WebKit caps what one WebContent process may reserve. On macOS that is
 * about 30 GiB of memories under 4 GiB; on an iPad (iPadOS 18.7, Safari
 * 26.6.1, measured with `public/memory-probe.html`) it is about 4-4.5 GiB
 * (18 memories of 256 MiB, 64 of 64 MiB, 250 of 16 MiB). The kernel's own
 * memory reserves a fixed 1 GiB of that, the page's buffers live in the
 * same address space, and up to four killed guests linger with their
 * memories (the kernel host's worker retirement). At the desktop's quarter
 * GiB per process only a few processes fit on an iPad, so `sudo` could not
 * start `mkdir` (exec: ENOMEM) and the shell could not fork (EAGAIN).
 *
 * So before it builds a kernel, a JavaScriptCore page measures what it can
 * still reserve, in a short-lived Worker (`public/memory-probe.js`), and
 * picks the largest per-process reservation that leaves room for
 * {@link WANTED_PROCESSES} processes beside the kernel and
 * {@link RESERVATION_HEADROOM_BYTES} of slack. A process that outgrows its
 * reservation gets ENOMEM, as under Linux's RLIMIT_AS.
 *
 * On iOS that is 128 MiB (room for 19 processes in an empty tab), the
 * floor: ipykernel (81 MiB) and a NumPy-sized cell run in it. A smaller
 * reservation would fit more processes but could not run CPython, and with
 * the kernel host's per-exec copies (yurtos-kernel#4238) in the same pool,
 * a run of commands under a simulated iOS cap got no further at 64 MiB than
 * at 128 MiB. So a probe that under-counts (a disposed kernel not yet
 * collected, or a probe whose every allocation failed) never takes a page
 * below it.
 */

const MIB = 1024 * 1024;

/** The desktop reservation (yurtos-kernel#2996): several times what
 *  CPython needs here (ipykernel 81 MiB, a 2000x2000 NumPy matmul 98 MiB). */
export const GUEST_MEMORY_RESERVATION_BYTES = 256 * MIB;
/** The smallest reservation offered: what CPython needs here (ipykernel
 *  81 MiB, a 2000x2000 NumPy matmul 98 MiB), with room to grow. */
export const MIN_GUEST_MEMORY_RESERVATION_BYTES = 128 * MIB;
/** The kernel's own shared memory maximum (the kernel host's
 *  `KERNEL_MAXIMUM_PAGES`, 16384 wasm pages). */
export const KERNEL_MEMORY_RESERVATION_BYTES = 1024 * MIB;
/** Room kept free beside the kernel and the guests: a snapshot restore's
 *  buffers and killed guests that linger with their memories. */
export const RESERVATION_HEADROOM_BYTES = 512 * MIB;
/** How many processes the reservation must leave room for at once: a
 *  Packages install (sudo, sh, mkdir, tar, ...) beside the shell and its
 *  jobs. */
export const WANTED_PROCESSES = 12;
/** The probe's unit, and how far it counts: enough to show that the
 *  largest reservation fits, so a desktop browser stops well short of its
 *  cap. */
export const PROBE_UNIT_BYTES = 32 * MIB;
export const PROBE_LIMIT_BYTES = KERNEL_MEMORY_RESERVATION_BYTES +
  RESERVATION_HEADROOM_BYTES +
  WANTED_PROCESSES * GUEST_MEMORY_RESERVATION_BYTES;
/** The probe Worker's script, served at the site root. */
export const PROBE_SCRIPT_PATH = "/memory-probe.js";

/** The reservation this page's guests get. */
export type GuestMemoryPlan = {
  reservationBytes: number;
  /** What the probe could reserve, or `undefined` when it could not run. */
  availableBytes?: number;
  /** How many processes of `reservationBytes` fit beside the kernel. */
  processes?: number;
};

/**
 * The larger power-of-two reservation, the desktop's quarter GiB or
 * {@link MIN_GUEST_MEMORY_RESERVATION_BYTES}, that leaves room for
 * {@link WANTED_PROCESSES} processes in `availableBytes`, beside the kernel
 * and the headroom. When even the smallest does not, the smallest.
 */
export function reservationForAvailableBytes(
  availableBytes: number,
): GuestMemoryPlan {
  const room = availableBytes - KERNEL_MEMORY_RESERVATION_BYTES -
    RESERVATION_HEADROOM_BYTES;
  let reservationBytes = GUEST_MEMORY_RESERVATION_BYTES;
  while (
    reservationBytes > MIN_GUEST_MEMORY_RESERVATION_BYTES &&
    room < WANTED_PROCESSES * reservationBytes
  ) {
    reservationBytes /= 2;
  }
  return {
    reservationBytes,
    availableBytes,
    processes: Math.max(0, Math.floor(room / reservationBytes)),
  };
}

/** What the probe Worker answers (`public/memory-probe.js`). */
type ProbeAnswer = { totalMiB: number; firstError: string };

/**
 * The engine's own Worker, taken when this module loads: a coordinator then
 * replaces `self.Worker` with a page-backed proxy for its guests
 * (`installCoordinatorWorkerProxy`), whose first message is a guest's port
 * and which the probe must not go through. Nothing blocks the coordinator
 * while it waits for the probe, so a Worker nested in it starts.
 */
const NativeWorker: typeof Worker | undefined = globalThis.Worker;

/** A Worker-like object: what {@link probeAvailableBytes} needs. */
export type ProbeWorker = {
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  postMessage(message: unknown): void;
  terminate(): void;
};

/**
 * Start the probe Worker, by default from {@link PROBE_SCRIPT_PATH} at
 * this script's site, with the engine's own Worker ({@link NativeWorker}).
 */
export function spawnProbeWorker(
  script: string | URL = new URL(PROBE_SCRIPT_PATH, self.location.href),
): ProbeWorker {
  if (NativeWorker === undefined) throw new Error("no Worker here");
  return new NativeWorker(script, { type: "module" }) as unknown as ProbeWorker;
}

/**
 * How many bytes of shared memory this tab can still reserve, counted in
 * {@link PROBE_UNIT_BYTES} memories up to {@link PROBE_LIMIT_BYTES}, in a
 * Worker that is terminated once it answers. `undefined` when no Worker
 * starts or it does not answer in `timeoutMs`.
 *
 * Once a Worker was started, the probe waits `settleMs` after terminating
 * it, whatever it answered: macOS WebKit gave a probe's reservations back
 * at once (4 x 1 GiB reserved right after a probe that took the whole
 * cap), but iOS is unmeasured (the iPad gave identical counts on runs
 * 1.5 s apart), and a Worker that timed out may still have been
 * reserving. The kernel's own 1 GiB comes next and must not be refused.
 */
export async function probeAvailableBytes(
  spawn: () => ProbeWorker = () => spawnProbeWorker(),
  options: { timeoutMs?: number; settleMs?: number } = {},
): Promise<number | undefined> {
  const { timeoutMs = 10_000, settleMs = 1_500 } = options;
  let worker: ProbeWorker;
  try {
    worker = spawn();
  } catch {
    return undefined;
  }
  const answer = await new Promise<ProbeAnswer | undefined>((resolve) => {
    const timer = setTimeout(() => resolve(undefined), timeoutMs);
    worker.onmessage = (event) => {
      clearTimeout(timer);
      const data = event.data as Partial<ProbeAnswer> | null;
      resolve(
        typeof data?.totalMiB === "number"
          ? { totalMiB: data.totalMiB, firstError: data.firstError ?? "" }
          : undefined,
      );
    };
    worker.onerror = () => {
      clearTimeout(timer);
      resolve(undefined);
    };
    try {
      worker.postMessage({
        sizes: [PROBE_UNIT_BYTES / MIB],
        limit: PROBE_LIMIT_BYTES / PROBE_UNIT_BYTES,
      });
    } catch {
      clearTimeout(timer);
      resolve(undefined);
    }
  });
  worker.terminate();
  if (settleMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, settleMs));
  }
  return answer === undefined ? undefined : answer.totalMiB * MIB;
}

/** The reservation when the probe cannot run. A Worker cannot tell an
 *  iPad from a Mac (iPadOS Safari sends a Mac user agent, and
 *  `WorkerNavigator` has no `maxTouchPoints`), so every JavaScriptCore page
 *  gets what fits on iOS. */
export const UNPROBED_RESERVATION_BYTES = 128 * MIB;

/** The plan for this page: measured when the probe runs, and otherwise
 *  {@link UNPROBED_RESERVATION_BYTES}. */
export async function planGuestMemory(
  probe: () => Promise<number | undefined> = () => probeAvailableBytes(),
): Promise<GuestMemoryPlan> {
  const available = await probe().catch(() => undefined);
  if (available !== undefined) return reservationForAvailableBytes(available);
  return { reservationBytes: UNPROBED_RESERVATION_BYTES };
}
