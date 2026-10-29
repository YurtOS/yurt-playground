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
 * still reserve, in a short-lived Worker (`public/memory-probe.js`; a
 * terminated Worker's reservations come back at once), and picks the
 * largest per-process reservation that leaves room for
 * {@link WANTED_PROCESSES} processes beside the kernel and
 * {@link RESERVATION_HEADROOM_BYTES} of slack. A process that outgrows its
 * reservation gets ENOMEM, as under Linux's RLIMIT_AS.
 */

const MIB = 1024 * 1024;

/** The desktop reservation (yurtos-kernel#2996): several times what
 *  CPython needs here (ipykernel 81 MiB, a 2000x2000 NumPy matmul 98 MiB). */
export const GUEST_MEMORY_RESERVATION_BYTES = 256 * MIB;
/** The smallest reservation offered: BusyBox runs in about 4 MiB and an
 *  idle CPython in about 21 MiB. */
export const MIN_GUEST_MEMORY_RESERVATION_BYTES = 32 * MIB;
/** The kernel's own shared memory maximum (the kernel host's
 *  `KERNEL_MAXIMUM_PAGES`, 16384 wasm pages). */
export const KERNEL_MEMORY_RESERVATION_BYTES = 1024 * MIB;
/** Room kept free beside the kernel and the guests: a snapshot restore's
 *  buffers and killed guests that linger with their memories. */
export const RESERVATION_HEADROOM_BYTES = 512 * MIB;
/** How many processes the reservation must leave room for at once: a
 *  Packages install (sudo, sh, mkdir, tar, ...) beside the shell and its
 *  jobs, with margin. */
export const WANTED_PROCESSES = 24;
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
 * The largest power-of-two reservation, from the desktop's quarter GiB
 * down to {@link MIN_GUEST_MEMORY_RESERVATION_BYTES}, that leaves room for
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
 * How many bytes of shared memory this tab can still reserve, counted in
 * {@link PROBE_UNIT_BYTES} memories up to {@link PROBE_LIMIT_BYTES}, in a
 * Worker that is terminated once it answers. `undefined` when no Worker
 * starts or it does not answer in `timeoutMs`. A probe that reached the
 * cap waits `settleMs` after the terminate, so its reservations are back
 * before the kernel asks for its own (the iPad gave identical counts on
 * runs 1.5 s apart).
 */
export async function probeAvailableBytes(
  spawn: () => ProbeWorker = () => {
    if (NativeWorker === undefined) throw new Error("no Worker here");
    return new NativeWorker(new URL(PROBE_SCRIPT_PATH, self.location.href), {
      type: "module",
    }) as unknown as ProbeWorker;
  },
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
  if (answer === undefined) return undefined;
  if (answer.firstError !== "" && settleMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, settleMs));
  }
  return answer.totalMiB * MIB;
}

/**
 * Whether this is a phone or tablet. iPadOS Safari may say it is a Mac;
 * a Mac has no touch points.
 */
export function isMobileDevice(
  userAgent: string | undefined = globalThis.navigator?.userAgent,
  maxTouchPoints: number | undefined = globalThis.navigator?.maxTouchPoints,
): boolean {
  if (userAgent === undefined) return false;
  if (/\b(iPad|iPhone|iPod|Android)\b/.test(userAgent)) return true;
  return /Macintosh/.test(userAgent) && (maxTouchPoints ?? 0) > 1;
}

/**
 * The plan for this page: measured when the probe runs, and otherwise the
 * reservation an iPad measurement supports on a phone or tablet (64 MiB:
 * about 4 GiB less the kernel and headroom leaves room for 40) or the
 * desktop's.
 */
export async function planGuestMemory(
  probe: () => Promise<number | undefined> = () => probeAvailableBytes(),
  mobile: boolean = isMobileDevice(),
): Promise<GuestMemoryPlan> {
  const available = await probe().catch(() => undefined);
  if (available !== undefined) return reservationForAvailableBytes(available);
  return {
    reservationBytes: mobile ? 64 * MIB : GUEST_MEMORY_RESERVATION_BYTES,
  };
}
