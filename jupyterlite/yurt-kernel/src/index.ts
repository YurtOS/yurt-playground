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
import { IKernel, IKernelSpecs } from "@jupyterlite/services";
import { ISignal, Signal } from "@lumino/signaling";

type RequestChannel = "shell" | "control" | "stdin";
type Channel = RequestChannel | "iopub";

/** Shape of `/playground-bridge.js` (see `src/lite_bridge.ts`). */
type PlaygroundKernelBridge = {
  ready: Promise<void>;
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

  dispose(): void {
    if (this._isDisposed) return;
    this._isDisposed = true;
    this._unsubscribe?.();
    for (const pending of this._pending.values()) pending();
    this._pending.clear();
    this._disposed.emit(void 0);
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
    const routed = {
      ...message,
      channel,
      header: { ...message.header, session: clientSession },
    };
    this._sendMessage(routed as KernelMessage.IMessage);
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
  private _lastSession: string | undefined;
  private _isDisposed = false;
  private _disposed = new Signal<this, void>(this);
}

const plugin: JupyterFrontEndPlugin<void> = {
  id: "@yurt/jupyterlite-yurt-kernel:plugin",
  autoStart: true,
  requires: [IKernelSpecs],
  activate: (_app: JupyterFrontEnd, kernelspecs: IKernelSpecs) => {
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
        return new YurtKernel(options);
      },
    });
  },
};

export default plugin;
