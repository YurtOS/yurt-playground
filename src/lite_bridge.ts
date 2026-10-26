/**
 * The page-side half of the JupyterLite Yurt kernel: boots the sandbox in the
 * coordinator Worker (the same way `page.ts` does for the ash page) and turns
 * its raw Jupyter passthrough into a send/receive pair a kernel plugin can
 * drive. Bundled to `public/playground-bridge.js` and imported by the
 * `jupyterlite/` extension at runtime, so every sandbox concern stays in the
 * deno-built bundles.
 */
import { desktopInfo } from "./native.ts";
import { announceSandbox, anotherSandboxRunning } from "./tab_presence.ts";
import {
  MEMORY_REFUSED_MESSAGE_TYPE,
  type MemoryRefusedMessage,
  mountMemoryRefusedBanner,
} from "./memory_refused.ts";
import { attachGuestWorkerFactory } from "./page_worker_bridge.ts";
import { type BridgeState, showBridgeState } from "./bridge_status.ts";
import { PYTHON_MISSING_TEXT } from "./notebook.ts";
import type { JupyterMessage } from "./jupyter_protocol.ts";
import type {
  JupyterChannel,
  JupyterRequestChannel,
} from "./jupyter_transport.ts";

export type PlaygroundKernelBridge = {
  /** Resolves once the current guest ipykernel answered kernel_info: the
   * first boot, or the latest restart. */
  readonly ready: Promise<void>;
  /** Replace the guest kernel with a fresh process; `ready` follows it. */
  restart(): Promise<void>;
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
  // The image has no python3; no kernel is coming (src/coordinator_start.ts).
  | { type: "python-missing" }
  | { type: "jupyter-restarted" }
  | {
    type: "jupyter-message";
    message: JupyterMessage;
    channel: JupyterChannel;
  }
  | { type: "cell-result" }
  | { type: "cell-error" }
  | MemoryRefusedMessage;

let bridge: PlaygroundKernelBridge | undefined;

/** One sandbox per page: every kernel the frontend starts shares it. */
export function startPlaygroundKernel(
  coordinatorUrl = "/coordinator.bundle.js",
): PlaygroundKernelBridge {
  if (bridge !== undefined) return bridge;
  const worker = new Worker(coordinatorUrl);
  attachGuestWorkerFactory(worker);
  const messageListeners = new Set<
    (message: JupyterMessage, channel: JupyterChannel) => void
  >();
  const statusListeners = new Set<(text: string) => void>();
  // `ready` is the boot at first and the latest restart afterwards; each is
  // settled by the coordinator's next ready/restarted or error message.
  let resolveReady: () => void = () => {};
  let rejectReady: (error: Error) => void = () => {};
  const arm = (): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
  let ready = arm();
  // The frontend shows a kernel that never became ready as a cell stuck at
  // `[*]`; the page's own line says what happened (src/bridge_status.ts).
  const show = (state: BridgeState) => showBridgeState(document, state);
  const status = (text: string) => {
    for (const listener of statusListeners) listener(text);
    show({ state: "booting", text });
  };
  worker.onmessage = (event: MessageEvent<FromWorker>) => {
    const msg = event.data;
    if (msg.type === "status") {
      status(msg.text);
    } else if (msg.type === "error") {
      for (const listener of statusListeners) listener(msg.message);
      show({ state: "error", text: msg.message });
      rejectReady(new Error(msg.message));
    } else if (msg.type === "python-missing") {
      for (const listener of statusListeners) listener(PYTHON_MISSING_TEXT);
      show({ state: "python-missing" });
      rejectReady(new Error(PYTHON_MISSING_TEXT));
    } else if (
      msg.type === "notebook-ready" || msg.type === "jupyter-restarted"
    ) {
      show({ state: "ready" });
      resolveReady();
    } else if (msg.type === "jupyter-message") {
      for (const listener of messageListeners) {
        listener(msg.message, msg.channel);
      }
    } else if (msg.type === MEMORY_REFUSED_MESSAGE_TYPE) {
      // The coordinator posts it from `bootPlayground` (src/boot.ts).
      mountMemoryRefusedBanner(document);
    }
  };
  worker.onerror = (event) => {
    const message = event.message || "coordinator worker failed";
    show({ state: "error", text: message });
    rejectReady(new Error(message));
  };
  // The desktop app's launcher answers /desktop.json and the sandbox is
  // native; on the hosted site the kernel boots in the worker, which needs
  // the page to be cross-origin isolated and says so if it is not.
  void desktopInfo().then(async (desktop) => {
    // The Notebook and Lab pages boot a sandbox of their own, like the home
    // page: they ask the other tabs first and answer them afterwards
    // (yurt-playground#84). The desktop app's sandbox is native, one per
    // launcher, so neither applies there.
    if (desktop === undefined) {
      if (await anotherSandboxRunning()) {
        status(
          "another tab already runs a sandbox; this boot shares the CPU with it",
        );
      }
      announceSandbox();
    }
    worker.postMessage({
      type: "start",
      cols: 80,
      rows: 24,
      isolated: globalThis.crossOriginIsolated === true,
      kernelPorts: desktop?.kernelPorts,
    });
  });
  bridge = {
    get ready() {
      return ready;
    },
    restart() {
      // Chain on the previous state so a restart requested during boot or
      // during another restart waits its turn instead of racing it.
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
  };
  return bridge;
}
