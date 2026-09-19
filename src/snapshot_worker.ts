/// <reference lib="deno.worker" />
/**
 * Coordinator for the continuous-snapshot demo (public/snapshot.html).
 *
 * Runs one sealable guest (a prime finder) in the kernel with a host pty on
 * the page's terminal, seals the whole sandbox every `SEAL_INTERVAL_MS`
 * (`KernelHostInterface.sealSandbox`) into IndexedDB, and on the next start
 * restores from the newest image (`KernelHostInterface.restore`) instead of
 * booting: close the tab, open it again, and the guest carries on from the
 * syscall it was sealed at. The whole ramfs lives in the kernel's memory, so
 * a restore stages no image at all.
 *
 * A classic Worker like the playground's coordinator: `WorkerHost` parks on
 * `Atomics.wait`, which the window thread may not do.
 */
import {
  defaultHostState,
  KernelHostInterface,
  pumpPtyMaster,
  s,
  type SandboxSealImage,
  type UserProcess,
} from "@yurt/kernel-host-interface-js";
import { fetchPlaygroundBytes } from "./boot.ts";
import { installCoordinatorWorkerProxy } from "./page_worker_bridge.ts";
import {
  clearSnapshot,
  loadSnapshot,
  type StoredSnapshot,
  storeSnapshot,
} from "./snapshot_store.ts";

installCoordinatorWorkerProxy();

const SEAL_INTERVAL_MS = 2000;
const GUEST_PATH = "./demo/primes.wasm";

export type SnapshotDemoToWorker =
  | { type: "start"; cols: number; rows: number; isolated: boolean }
  | { type: "in"; text: string }
  | { type: "resize"; rows: number; cols: number }
  /** Drop the stored image; the next start boots fresh. */
  | { type: "reset" };

export type SnapshotDemoFromWorker =
  | { type: "status"; text: string }
  | { type: "out"; bytes: number[] }
  | { type: "restored"; sealedAt: number; bytes: number }
  | { type: "booted" }
  | { type: "sealed"; sealedAt: number; bytes: number; ms: number }
  | { type: "error"; message: string };

function post(message: SnapshotDemoFromWorker): void {
  self.postMessage(message);
}

function imageBytes(image: SandboxSealImage): number {
  return image.kernelMemory.byteLength +
    image.processes.reduce(
      (sum, process) => sum + process.snapshot.memoryBytes.byteLength,
      0,
    );
}

type Live = {
  mk: KernelHostInterface;
  pty: number;
  process: UserProcess;
  stopPump: () => void;
};

let live: Live | undefined;
let sealing = false;

function attachTerminal(
  mk: KernelHostInterface,
  pty: number,
  size: { cols: number; rows: number },
): () => void {
  mk.ptySetWinsize(pty, size.rows, size.cols);
  return pumpPtyMaster(mk, pty, (bytes: Uint8Array) => {
    post({ type: "out", bytes: Array.from(bytes) });
  });
}

/** The guest runs forever; an exit is news, and says why the output stopped. */
function watchExit(process: UserProcess): void {
  process.runStartAsync().then(
    (code) => post({ type: "status", text: `the guest exited with ${code}` }),
    (error) =>
      post({
        type: "status",
        text: `the guest failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      }),
  );
}

async function bootFresh(
  kernel: Uint8Array,
  size: { cols: number; rows: number },
): Promise<Live> {
  post({ type: "status", text: "loading the guest" });
  const response = await fetch(GUEST_PATH);
  if (!response.ok) {
    throw new Error(`fetch ${GUEST_PATH} failed: ${response.status}`);
  }
  const guest = new Uint8Array(await response.arrayBuffer());
  post({ type: "status", text: "booting the kernel" });
  const mk = await KernelHostInterface.load(kernel, defaultHostState());
  const process = await mk.spawnUserProcessWithArgsAsync(guest, [s("primes")], {
    TERM: "xterm-256color",
  });
  const pty = mk.attachHostPty(process.pid);
  const stopPump = attachTerminal(mk, pty, size);
  watchExit(process);
  post({ type: "booted" });
  return { mk, pty, process, stopPump };
}

async function restoreStored(
  kernel: Uint8Array,
  stored: StoredSnapshot,
  size: { cols: number; rows: number },
): Promise<Live> {
  post({ type: "status", text: "restoring the sandbox" });
  const restored = await KernelHostInterface.restore(
    kernel,
    stored.image,
    defaultHostState(),
  );
  const [process] = restored.processes;
  if (process === undefined) throw new Error("the image holds no process");
  // The pty survived inside the kernel's memory; only the pump is new.
  const stopPump = attachTerminal(restored.host, stored.pty, size);
  watchExit(process);
  post({
    type: "restored",
    sealedAt: stored.sealedAt,
    bytes: imageBytes(stored.image),
  });
  return { mk: restored.host, pty: stored.pty, process, stopPump };
}

async function sealOnce(current: Live): Promise<void> {
  if (sealing) return;
  sealing = true;
  const started = performance.now();
  try {
    const image = await current.mk.sealSandbox();
    const sealedAt = Date.now();
    await storeSnapshot({ image, pty: current.pty, sealedAt });
    post({
      type: "sealed",
      sealedAt,
      bytes: imageBytes(image),
      ms: Math.round(performance.now() - started),
    });
  } catch (error) {
    post({
      type: "status",
      text: `seal failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    });
  } finally {
    sealing = false;
  }
}

self.onmessage = async (event: MessageEvent<SnapshotDemoToWorker>) => {
  const msg = event.data;
  if (msg.type === "in") {
    live?.mk.ptyMasterWrite(live.pty, new TextEncoder().encode(msg.text));
    return;
  }
  if (msg.type === "resize") {
    live?.mk.ptySetWinsize(live.pty, msg.rows, msg.cols);
    return;
  }
  if (msg.type === "reset") {
    await clearSnapshot();
    post({
      type: "status",
      text: "stored image dropped; reload to boot fresh",
    });
    return;
  }
  if (msg.type !== "start") return;
  try {
    if (!msg.isolated) throw new Error("not crossOriginIsolated");
    const size = { cols: msg.cols, rows: msg.rows };
    post({ type: "status", text: "loading kernel" });
    const kernel = await fetchPlaygroundBytes("./yurt_kernel.wasm");
    const stored = await loadSnapshot();
    if (stored === undefined) {
      live = await bootFresh(kernel, size);
    } else {
      try {
        live = await restoreStored(kernel, stored, size);
      } catch (error) {
        // An image this host cannot bring back (an older image shape, a
        // guest it cannot rewind) is dropped rather than left to fail on
        // every start; the status says what happened.
        await clearSnapshot();
        const reason = error instanceof Error ? error.message : String(error);
        post({
          type: "status",
          text: `stored image could not be restored (${reason}); booting fresh`,
        });
        live = await bootFresh(kernel, size);
      }
    }
    const current = live;
    setInterval(() => void sealOnce(current), SEAL_INTERVAL_MS);
  } catch (error) {
    post({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
