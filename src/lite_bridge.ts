/**
 * The page-side half of the JupyterLite Yurt kernel: boots the sandbox in the
 * coordinator Worker (the same way `page.ts` does for the ash page) and turns
 * its raw Jupyter passthrough into a send/receive pair a kernel plugin can
 * drive. Bundled to `public/playground-bridge.js` and imported by the
 * `jupyterlite/` extension at runtime, so every sandbox concern stays in the
 * deno-built bundles.
 */
import { attachGuestWorkerFactory } from "./page_worker_bridge.ts";
import type { JupyterMessage } from "./jupyter_protocol.ts";
import type {
  JupyterChannel,
  JupyterRequestChannel,
} from "./jupyter_transport.ts";

export type PlaygroundKernelBridge = {
  /** Resolves once the guest ipykernel answered kernel_info. */
  ready: Promise<void>;
  send(message: JupyterMessage, channel: JupyterRequestChannel): void;
  onMessage(
    listener: (message: JupyterMessage, channel: JupyterChannel) => void,
  ): () => void;
  onStatus(listener: (text: string) => void): () => void;
};

type FromWorker =
  | { type: "status"; text: string }
  | { type: "out"; bytes: number[] }
  | { type: "error"; message: string }
  | { type: "notebook-ready" }
  | {
    type: "jupyter-message";
    message: JupyterMessage;
    channel: JupyterChannel;
  }
  | { type: "cell-result" }
  | { type: "cell-error" };

let bridge: PlaygroundKernelBridge | undefined;

/** One sandbox per page: every kernel the frontend starts shares it. */
export function startPlaygroundKernel(
  coordinatorUrl = "/coordinator.bundle.js",
): PlaygroundKernelBridge {
  if (bridge !== undefined) return bridge;
  if (globalThis.crossOriginIsolated !== true) {
    throw new Error("not crossOriginIsolated: the page needs COOP/COEP");
  }
  const worker = new Worker(coordinatorUrl);
  attachGuestWorkerFactory(worker);
  const messageListeners = new Set<
    (message: JupyterMessage, channel: JupyterChannel) => void
  >();
  const statusListeners = new Set<(text: string) => void>();
  let resolveReady: () => void = () => {};
  let rejectReady: (error: Error) => void = () => {};
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  worker.onmessage = (event: MessageEvent<FromWorker>) => {
    const msg = event.data;
    if (msg.type === "status") {
      for (const listener of statusListeners) listener(msg.text);
    } else if (msg.type === "error") {
      for (const listener of statusListeners) listener(msg.message);
      rejectReady(new Error(msg.message));
    } else if (msg.type === "notebook-ready") {
      resolveReady();
    } else if (msg.type === "jupyter-message") {
      for (const listener of messageListeners) {
        listener(msg.message, msg.channel);
      }
    }
  };
  worker.onerror = (event) => {
    rejectReady(new Error(event.message || "coordinator worker failed"));
  };
  worker.postMessage({ type: "start", cols: 80, rows: 24, isolated: true });
  bridge = {
    ready,
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
  };
  return bridge;
}
