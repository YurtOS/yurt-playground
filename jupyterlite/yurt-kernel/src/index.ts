/**
 * JupyterLite kernel plugin for the Yurt playground.
 *
 * JupyterLite supplies the JupyterLab / Notebook frontend and a browser-side
 * Jupyter Server API; this plugin registers one kernelspec, `yurt`, whose
 * kernel is the unmodified ipykernel running inside the Yurt sandbox on this
 * page. Messages are relayed verbatim to the guest's ZMQ sockets through the
 * playground's coordinator Worker (`/playground-bridge.js`); nothing executes
 * in the browser.
 */
import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin,
} from "@jupyterlab/application";
import type { KernelMessage } from "@jupyterlab/services";
import { IKernel, IKernelClient, IKernelSpecs } from "@jupyterlite/services";
import { ISignal, Signal } from "@lumino/signaling";

type RequestChannel = "shell" | "control" | "stdin";
type Channel = RequestChannel | "iopub";

/** Shape of `/playground-bridge.js` (see `src/lite_bridge.ts`). */
type PlaygroundKernelBridge = {
  /** The first boot, then the latest restart. */
  readonly ready: Promise<void>;
  /** Replace the guest ipykernel with a fresh process. */
  restart(): Promise<void>;
  send(message: KernelMessage.IMessage, channel: RequestChannel): void;
  onMessage(
    listener: (message: KernelMessage.IMessage, channel: Channel) => void,
  ): () => void;
  onStatus(listener: (text: string) => void): () => void;
};

type BridgeModule = {
  startPlaygroundKernel(coordinatorUrl?: string): PlaygroundKernelBridge;
};

const BRIDGE_URL = "/playground-bridge.js";
const MAX_TRACKED_REQUESTS = 4096;
/** ipykernel answers interrupt_request from its control thread even while
 * a cell runs, so a missing reply means a wedged kernel; do not hang the
 * frontend on it. */
const INTERRUPT_REPLY_TIMEOUT_MS = 10_000;

/** Live kernels by id, so the client's interrupt can reach the right one. */
const kernels = new Map<string, YurtKernel>();

let bridgePromise: Promise<PlaygroundKernelBridge> | undefined;

/** One sandbox per page, booted on first use and shared by every kernel. */
function bridge(): Promise<PlaygroundKernelBridge> {
  if (bridgePromise === undefined) {
    // Same-origin runtime import: the bridge is built by the playground's
    // deno bundle, not by this extension's webpack.
    bridgePromise = import(/* webpackIgnore: true */ BRIDGE_URL).then(
      (module: BridgeModule) => module.startPlaygroundKernel(),
    );
  }
  return bridgePromise;
}

class YurtKernel implements IKernel {
  constructor(options: IKernel.IOptions) {
    this._id = options.id;
    this._name = options.name;
    this._location = options.location;
    this._sendMessage = options.sendMessage;
    this.ready = bridge().then(async (b) => {
      this._unsubscribe = b.onMessage((message, channel) =>
        this._fromKernel(message, channel)
      );
      await b.ready;
      this._bridge = b;
    });
  }

  get id(): string {
    return this._id;
  }

  get name(): string {
    return this._name;
  }

  get location(): string {
    return this._location;
  }

  readonly ready: Promise<void>;

  get disposed(): ISignal<this, void> {
    return this._disposed;
  }

  get isDisposed(): boolean {
    return this._isDisposed;
  }

  /**
   * JupyterLite disposes a kernel for both restart and shutdown, and starts
   * a new one afterwards on restart. Either way the guest process this
   * kernel talked to is finished: it is replaced by a fresh one, which kills
   * a running cell and drops every variable, and the next kernel's `ready`
   * waits for the replacement.
   */
  dispose(): void {
    if (this._isDisposed) return;
    this._isDisposed = true;
    kernels.delete(this._id);
    this._unsubscribe?.();
    for (const pending of this._pending.values()) pending();
    this._pending.clear();
    if (this._bridge !== undefined) {
      this._bridge.restart().catch(() => {
        // The next kernel's `ready` reports the failure.
      });
    }
    this._disposed.emit(void 0);
  }

  /**
   * Interrupt the running cell: an `interrupt_request` on the control
   * channel, which ipykernel answers by sending itself SIGINT, raising
   * KeyboardInterrupt in the cell. Resolves on the reply or after a bound.
   */
  async interrupt(): Promise<void> {
    await this.ready;
    const msgId = crypto.randomUUID();
    this._internal.add(msgId);
    const request = {
      channel: "control",
      header: {
        msg_id: msgId,
        session: this._lastSession ?? this._id,
        username: "yurt",
        msg_type: "interrupt_request",
        version: "5.3",
        date: new Date().toISOString(),
      },
      parent_header: {},
      metadata: {},
      content: {},
      buffers: [],
    } as unknown as KernelMessage.IMessage;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.handleMessage(request),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, INTERRUPT_REPLY_TIMEOUT_MS);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      this._internal.delete(msgId);
      this._pending.delete(msgId);
    }
  }

  /**
   * Forward a client request to the guest kernel. A shell or control request
   * resolves when its reply arrives, which is what lets JupyterLite serialise
   * cell execution and stop on an error the way JupyterLab does; a stdin
   * reply has no reply of its own.
   */
  async handleMessage(msg: KernelMessage.IMessage): Promise<void> {
    await this.ready;
    const b = this._bridge!;
    const channel = msg.channel as RequestChannel;
    const msgId = msg.header.msg_id;
    this._sessions.set(msgId, msg.header.session);
    this._lastSession = msg.header.session;
    // The mapping outlives the reply: ipykernel publishes the request's
    // trailing `status: idle` on iopub after the shell reply. Bound it.
    if (this._sessions.size > MAX_TRACKED_REQUESTS) {
      this._sessions.delete(this._sessions.keys().next().value!);
    }
    if (channel === "stdin") {
      b.send(msg, channel);
      return;
    }
    const replied = new Promise<void>((resolve) => {
      this._pending.set(msgId, resolve);
    });
    b.send(msg, channel);
    await replied;
  }

  /** Route a message the guest kernel emitted back to the frontend. */
  private _fromKernel(message: KernelMessage.IMessage, channel: Channel): void {
    if (this._isDisposed) return;
    const parentId = (message.parent_header as { msg_id?: string }).msg_id;
    const clientSession = parentId === undefined
      ? undefined
      : this._sessions.get(parentId);
    // ipykernel stamps everything it emits with its own session id, while
    // JupyterLite routes by the client session named in the header: shell
    // and control replies go to that one client, and an iopub message is
    // broadcast only after that lookup succeeds. So every message is
    // re-stamped with the session of the request it answers.
    if (channel === "iopub") {
      // Every kernel on this page shares one ipykernel; forward the output
      // of requests this kernel sent, plus kernel-wide status with no parent
      // (attributed to whichever client last spoke).
      if (parentId !== undefined && clientSession === undefined) return;
      const session = clientSession ?? this._lastSession;
      if (session === undefined) return;
      this._sendMessage({
        ...message,
        channel,
        header: { ...message.header, session },
      } as KernelMessage.IMessage);
      return;
    }
    if (clientSession === undefined) return;
    if (!this._internal.has(parentId!)) {
      // A reply to something this plugin sent on its own (interrupt) has no
      // frontend future waiting for it; only the pending resolve below.
      const routed = {
        ...message,
        channel,
        header: { ...message.header, session: clientSession },
      };
      this._sendMessage(routed as KernelMessage.IMessage);
    }
    const resolve = this._pending.get(parentId!);
    if (resolve !== undefined) {
      this._pending.delete(parentId!);
      resolve();
    }
  }

  private _id: string;
  private _name: string;
  private _location: string;
  private _sendMessage: IKernel.SendMessage;
  private _bridge: PlaygroundKernelBridge | undefined;
  private _unsubscribe: (() => void) | undefined;
  private _pending = new Map<string, () => void>();
  private _sessions = new Map<string, string>();
  private _internal = new Set<string>();
  private _lastSession: string | undefined;
  private _isDisposed = false;
  private _disposed = new Signal<this, void>(this);
}

const plugin: JupyterFrontEndPlugin<void> = {
  id: "@yurt/jupyterlite-yurt-kernel:plugin",
  autoStart: true,
  requires: [IKernelSpecs, IKernelClient],
  activate: (
    _app: JupyterFrontEnd,
    kernelspecs: IKernelSpecs,
    client: IKernelClient,
  ) => {
    // JupyterLite's kernel client implements interrupt by cancelling the
    // cells it has queued; the kernel itself is never told. The frontend's
    // KernelConnection calls this method, so wrap it: the guest kernel
    // gets its interrupt_request first, then the queue is cancelled.
    const cancelQueued = client.interrupt.bind(client);
    client.interrupt = async (kernelId: string): Promise<void> => {
      await kernels.get(kernelId)?.interrupt();
      await cancelQueued(kernelId);
    };
    kernelspecs.register({
      spec: {
        name: "yurt",
        display_name: "Python 3 (Yurt sandbox)",
        language: "python",
        argv: [],
        resources: {
          "logo-32x32": "",
          "logo-64x64": "",
        },
      },
      create: async (options: IKernel.IOptions): Promise<IKernel> => {
        const kernel = new YurtKernel(options);
        kernels.set(options.id, kernel);
        return kernel;
      },
    });
  },
};

export default plugin;
