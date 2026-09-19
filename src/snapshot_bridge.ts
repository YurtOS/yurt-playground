/**
 * The page-side half of the suspend/resume notebook kernel: the same
 * send/receive pair as `lite_bridge.ts` gives the JupyterLite Yurt kernel,
 * over `src/notebook_kernel_worker.ts` instead of the ipykernel coordinator,
 * plus the suspend/resume controls the kernel plugin's panel drives.
 * Bundled to `public/snapshot-bridge.js` and imported by the `jupyterlite/`
 * extension at runtime for the `yurt-snapshot` kernelspec.
 */
import { attachGuestWorkerFactory } from "./page_worker_bridge.ts";
import type { JupyterMessage } from "./jupyter_protocol.ts";
import type {
  JupyterChannel,
  JupyterRequestChannel,
} from "./jupyter_transport.ts";
import type {
  NotebookKernelFromWorker,
  SnapshotState,
} from "./notebook_kernel_worker.ts";

export type { SnapshotState };

export type SnapshotKernelBridge = {
  /** Resolves once the kernel is running: the first boot, or the latest
   * restart. */
  readonly ready: Promise<void>;
  /** Replace the guest Python with a fresh process; `ready` follows it. */
  restart(): Promise<void>;
  send(message: JupyterMessage, channel: JupyterRequestChannel): void;
  onMessage(
    listener: (message: JupyterMessage, channel: JupyterChannel) => void,
  ): () => void;
  onStatus(listener: (text: string) => void): () => void;
  /** Seal the sandbox into the browser's IndexedDB and tear it down. */
  suspend(): void;
  /** Bring the sealed sandbox back; a running cell continues. */
  resume(): void;
  /** Drop the stored image; the next boot starts fresh. */
  forget(): void;
  onSnapshot(listener: (state: SnapshotState) => void): () => void;
  /** The last snapshot state announced. */
  readonly snapshot: SnapshotState;
};

let bridge: SnapshotKernelBridge | undefined;

/** One sandbox per page: every kernel the frontend starts shares it. */
export function startSnapshotKernel(
  workerUrl = "/notebook_kernel.bundle.js",
): SnapshotKernelBridge {
  if (bridge !== undefined) return bridge;
  const worker = new Worker(workerUrl);
  attachGuestWorkerFactory(worker);
  const messageListeners = new Set<
    (message: JupyterMessage, channel: JupyterChannel) => void
  >();
  const statusListeners = new Set<(text: string) => void>();
  const snapshotListeners = new Set<(state: SnapshotState) => void>();
  let snapshot: SnapshotState = { state: "booting" };
  let resolveReady: () => void = () => {};
  let rejectReady: (error: Error) => void = () => {};
  const arm = (): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
  let ready = arm();
  worker.onmessage = (event: MessageEvent<NotebookKernelFromWorker>) => {
    const msg = event.data;
    switch (msg.type) {
      case "status":
        for (const listener of statusListeners) listener(msg.text);
        return;
      case "error":
        for (const listener of statusListeners) listener(msg.message);
        rejectReady(new Error(msg.message));
        return;
      case "notebook-ready":
      case "jupyter-restarted":
        resolveReady();
        return;
      case "jupyter-message":
        for (const listener of messageListeners) {
          listener(msg.message, msg.channel);
        }
        return;
      case "snapshot":
        snapshot = msg.snapshot;
        for (const listener of snapshotListeners) listener(msg.snapshot);
        return;
    }
  };
  worker.onerror = (event) => {
    rejectReady(new Error(event.message || "notebook kernel worker failed"));
  };
  worker.postMessage({
    type: "start",
    isolated: globalThis.crossOriginIsolated === true,
  });
  bridge = {
    get ready() {
      return ready;
    },
    get snapshot() {
      return snapshot;
    },
    restart() {
      ready = ready.catch(() => {}).then(() => {
        const next = arm();
        worker.postMessage({ type: "jupyter-restart" });
        return next;
      });
      return ready;
    },
    send(message, channel) {
      worker.postMessage({ type: "jupyter-send", message, channel });
    },
    onMessage(listener) {
      messageListeners.add(listener);
      return () => messageListeners.delete(listener);
    },
    onStatus(listener) {
      statusListeners.add(listener);
      return () => statusListeners.delete(listener);
    },
    suspend() {
      worker.postMessage({ type: "suspend" });
    },
    resume() {
      worker.postMessage({ type: "resume" });
    },
    forget() {
      worker.postMessage({ type: "forget" });
    },
    onSnapshot(listener) {
      snapshotListeners.add(listener);
      return () => snapshotListeners.delete(listener);
    },
  };
  return bridge;
}
