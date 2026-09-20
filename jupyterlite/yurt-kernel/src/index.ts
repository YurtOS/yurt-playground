/**
 * JupyterLite kernel plugin for the Yurt playground.
 *
 * JupyterLite supplies the JupyterLab / Notebook frontend and a browser-side
 * Jupyter Server API; this plugin registers two kernelspecs:
 *
 * - `yurt`: the unmodified ipykernel running inside the Yurt sandbox on
 *   this page. Messages are relayed verbatim to the guest's ZMQ sockets
 *   through the playground's coordinator Worker (`/playground-bridge.js`);
 *   nothing executes in the browser.
 * - `yurt-snapshot`: one CPython process in a sandbox that can be suspended
 *   (sealed into IndexedDB) and resumed, mid-cell, through
 *   `/snapshot-bridge.js`. A floating panel carries the two buttons.
 *
 * Both bridges present the same send/receive pair, so one kernel class
 * serves both specs.
 */
import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin,
} from "@jupyterlab/application";
import { INotebookTracker, NotebookActions } from "@jupyterlab/notebook";
import type { KernelMessage } from "@jupyterlab/services";
import { IKernel, IKernelClient, IKernelSpecs } from "@jupyterlite/services";
import { ISignal, Signal } from "@lumino/signaling";

type RequestChannel = "shell" | "control" | "stdin";
type Channel = RequestChannel | "iopub";
type PendingRequest = {
  message: KernelMessage.IMessage;
  internal: boolean;
  resolve: () => void;
};

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

type SnapshotState =
  | { state: "booting" }
  | { state: "running"; restoredFrom?: number; sealedAt?: number }
  | { state: "sealing" }
  | { state: "suspended"; sealedAt: number; bytes: number; ms: number }
  | { state: "resuming" };

/** Shape of `/snapshot-bridge.js` (see `src/snapshot_bridge.ts`). */
type SnapshotKernelBridge = PlaygroundKernelBridge & {
  suspend(): void;
  resume(): void;
  forget(): void;
  onSnapshot(listener: (state: SnapshotState) => void): () => void;
  readonly snapshot: SnapshotState;
  readonly pendingCell: { code: string; executionCount: number } | undefined;
};

type BridgeModule = {
  startPlaygroundKernel(coordinatorUrl?: string): PlaygroundKernelBridge;
};

type SnapshotBridgeModule = {
  startSnapshotKernel(workerUrl?: string): SnapshotKernelBridge;
};

const BRIDGE_URL = "/playground-bridge.js";
const SNAPSHOT_BRIDGE_URL = "/snapshot-bridge.js";
const MAX_TRACKED_REQUESTS = 4096;
/** ipykernel answers interrupt_request from its control thread even while
 * a cell runs, so a missing reply means a wedged kernel; do not hang the
 * frontend on it. */
const INTERRUPT_REPLY_TIMEOUT_MS = 10_000;

/** Live kernels by id, so the client's interrupt can reach the right one. */
const kernels = new Map<string, YurtKernel>();

let bridgePromise: Promise<PlaygroundKernelBridge> | undefined;
let snapshotBridgePromise: Promise<SnapshotKernelBridge> | undefined;

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

/** The suspend/resume sandbox: its own worker, and the panel with it. */
function snapshotBridge(): Promise<SnapshotKernelBridge> {
  if (snapshotBridgePromise === undefined) {
    snapshotBridgePromise = import(
      /* webpackIgnore: true */ SNAPSHOT_BRIDGE_URL
    ).then((module: SnapshotBridgeModule) => {
      const b = module.startSnapshotKernel();
      mountSnapshotPanel(b);
      return b;
    });
  }
  return snapshotBridgePromise;
}

// ── The suspend/resume panel ──────────────────────────────────────────────

function formatBytes(bytes: number): string {
  return `${(bytes / 1e6).toFixed(1)} MB`;
}

function describeSnapshot(state: SnapshotState): string {
  switch (state.state) {
    case "booting":
      return "booting the sandbox…";
    case "running":
      if (state.restoredFrom !== undefined) {
        return `running — resumed from the image sealed at ${
          new Date(state.restoredFrom).toLocaleTimeString()
        }`;
      }
      return state.sealedAt === undefined
        ? "running"
        : `running — sealed at ${
          new Date(state.sealedAt).toLocaleTimeString()
        } (again every 10 s while a cell runs; the tab can be closed)`;
    case "sealing":
      return "sealing…";
    case "suspended":
      return `suspended: ${formatBytes(state.bytes)} sealed in ${state.ms} ms, in IndexedDB`;
    case "resuming":
      return "resuming…";
  }
}

/**
 * A small fixed panel on the page: the sandbox's state, Suspend, Resume,
 * and a status line. Plain DOM rather than a JupyterLab toolbar item so it
 * is the same in the Notebook and Lab interfaces and needs no settings
 * schema.
 */
function mountSnapshotPanel(b: SnapshotKernelBridge): void {
  const panel = document.createElement("div");
  panel.className = "yurt-snapshot-panel";
  panel.innerHTML = `
    <div class="yurt-snapshot-title">Yurt sandbox</div>
    <div class="yurt-snapshot-state"></div>
    <div class="yurt-snapshot-buttons">
      <button class="yurt-snapshot-suspend" type="button">Suspend</button>
      <button class="yurt-snapshot-resume" type="button">Resume</button>
    </div>
    <div class="yurt-snapshot-status"></div>`;
  const stateLine = panel.querySelector(".yurt-snapshot-state")!;
  const statusLine = panel.querySelector(".yurt-snapshot-status")!;
  const suspend = panel.querySelector<HTMLButtonElement>(
    ".yurt-snapshot-suspend",
  )!;
  const resume = panel.querySelector<HTMLButtonElement>(
    ".yurt-snapshot-resume",
  )!;
  const render = (state: SnapshotState) => {
    stateLine.textContent = describeSnapshot(state);
    panel.dataset.state = state.state;
    // The last periodic seal, for whoever wants to know the tab is safe to
    // close (the acceptance test does).
    if (state.state === "running" && state.sealedAt !== undefined) {
      panel.dataset.sealedAt = String(state.sealedAt);
    } else if (state.state !== "running") {
      delete panel.dataset.sealedAt;
    }
    suspend.disabled = state.state !== "running";
    resume.disabled = state.state !== "suspended";
    // A boot-time progress line ("starting Python") is stale once the
    // state moved on; only a message after that is worth keeping.
    statusLine.textContent = "";
  };
  render(b.snapshot);
  b.onSnapshot(render);
  b.onStatus((text) => {
    statusLine.textContent = text;
  });
  suspend.addEventListener("click", () => b.suspend());
  resume.addEventListener("click", () => b.resume());
  document.body.appendChild(panel);
}

class YurtKernel implements IKernel {
  constructor(
    options: IKernel.IOptions,
    start: () => Promise<PlaygroundKernelBridge>,
  ) {
    this._id = options.id;
    this._name = options.name;
    this._location = options.location;
    this._sendMessage = options.sendMessage;
    this.ready = start().then(async (b) => {
      this._unsubscribe = b.onMessage((message, channel) =>
        this._fromKernel(message, channel)
      );
      await b.ready;
      if (this._isDisposed) {
        this._unsubscribe?.();
        this._unsubscribe = undefined;
        return;
      }
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
    for (const pending of this._pending.values()) pending.resolve();
    this._pending.clear();
    // The bridge is shared by every JupyterLite kernel on this page. A
    // restart replaces the guest for all clients, so release every other
    // client's old request state before replacing the process.
    if (this._bridge !== undefined) {
      for (const kernel of kernels.values()) {
        kernel._prepareForGuestRestart();
      }
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
    if (this._isDisposed) return;
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
    let timedOut = false;
    try {
      await Promise.race([
        this.handleMessage(request),
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            timedOut = true;
            this._cancelled.add(msgId);
            this._pending.get(msgId)?.resolve();
            resolve();
          }, INTERRUPT_REPLY_TIMEOUT_MS);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      this._internal.delete(msgId);
      this._sessions.delete(msgId);
      if (!timedOut) this._cancelled.delete(msgId);
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
    if (this._isDisposed) return;
    const b = this._bridge!;
    const generation = this._generation;
    await b.ready;
    if (this._isDisposed) return;
    if (generation !== this._generation) {
      if (!this._internal.has(msg.header.msg_id)) {
        this._sendRestartMessages(msg);
      }
      return;
    }
    const channel = msg.channel as RequestChannel;
    const msgId = msg.header.msg_id;
    if (this._cancelled.delete(msgId)) return;
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
      this._pending.set(msgId, {
        message: msg,
        internal: this._internal.has(msgId),
        resolve,
      });
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
      if (
        parentId !== undefined &&
        message.header.msg_type === "status" &&
        (message.content as { execution_state?: string }).execution_state ===
          "idle"
      ) {
        if (this._awaitingIdle.delete(parentId)) {
          this._sessions.delete(parentId);
        } else {
          const pending = this._pending.get(parentId);
          if (
            pending?.message.channel === "shell" &&
            pending.message.header.msg_type === "execute_request"
          ) {
            this._idleBeforeReply.add(parentId);
          }
        }
      }
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
    const pending = this._pending.get(parentId!);
    if (pending !== undefined) {
      this._pending.delete(parentId!);
      if (
        pending.message.channel === "shell" &&
        pending.message.header.msg_type === "execute_request"
      ) {
        if (this._idleBeforeReply.delete(parentId!)) {
          this._sessions.delete(parentId!);
        } else {
          this._awaitingIdle.set(parentId!, pending.message);
        }
      }
      pending.resolve();
    }
  }

  /** Drop requests and session mappings that belong to a guest being replaced. */
  private _prepareForGuestRestart(): void {
    this._generation++;
    for (const pending of this._pending.values()) {
      if (!pending.internal) this._sendRestartMessages(pending.message);
      pending.resolve();
    }
    this._pending.clear();
    for (const message of this._awaitingIdle.values()) {
      this._sendIdleMessage(message);
    }
    this._awaitingIdle.clear();
    this._idleBeforeReply.clear();
    this._sessions.clear();
    this._internal.clear();
    this._lastSession = undefined;
  }

  private _sendRestartMessages(message: KernelMessage.IMessage): void {
    const parent = message.header;
    const reply = {
      channel: message.channel,
      header: {
        ...parent,
        msg_id: crypto.randomUUID(),
        msg_type: parent.msg_type === "execute_request"
          ? "execute_reply"
          : `${parent.msg_type.replace(/_request$/, "")}_reply`,
        date: new Date().toISOString(),
      },
      parent_header: parent,
      metadata: {},
      content: {
        status: "error",
        ename: "KernelRestarted",
        evalue: "Kernel restarted before the request completed",
        traceback: [],
      },
      buffers: [],
    } as unknown as KernelMessage.IMessage;
    this._sendMessage(reply);
    this._sendIdleMessage(message);
  }

  private _sendIdleMessage(message: KernelMessage.IMessage): void {
    const parent = message.header;
    const idle = {
      channel: "iopub",
      header: {
        ...parent,
        msg_id: crypto.randomUUID(),
        msg_type: "status",
        session: parent.session,
        date: new Date().toISOString(),
      },
      parent_header: parent,
      metadata: {},
      content: { execution_state: "idle" },
      buffers: [],
    } as unknown as KernelMessage.IMessage;
    this._sendMessage(idle);
  }

  private _id: string;
  private _name: string;
  private _location: string;
  private _sendMessage: IKernel.SendMessage;
  private _bridge: PlaygroundKernelBridge | undefined;
  private _unsubscribe: (() => void) | undefined;
  private _pending = new Map<string, PendingRequest>();
  private _awaitingIdle = new Map<string, KernelMessage.IMessage>();
  private _idleBeforeReply = new Set<string>();
  private _sessions = new Map<string, string>();
  private _internal = new Set<string>();
  private _lastSession: string | undefined;
  private _isDisposed = false;
  private _generation = 0;
  private _cancelled = new Set<string>();
  private _disposed = new Signal<this, void>(this);
}

/**
 * A reopened notebook whose sandbox came back mid-cell (#109): find that
 * cell -- the one whose source the guest is still running -- and run it, so
 * its request becomes the parent of the continuation (the worker binds the
 * request rather than running the code again, and replays what the cell had
 * printed). The notebook attaches to its kernel a little after the kernel is
 * ready, so this looks for it for a while.
 */
async function takePendingCell(
  b: SnapshotKernelBridge,
  tracker: INotebookTracker | null,
  kernelId: string,
): Promise<void> {
  const pending = b.pendingCell;
  if (pending === undefined || tracker === null) return;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (b.pendingCell === undefined) return;
    const panel = tracker.find((widget) =>
      widget.sessionContext.session?.kernel?.id === kernelId
    ) ?? tracker.currentWidget;
    const index = panel?.content.widgets.findIndex((cell) =>
      cell.model.type === "code" &&
      cell.model.sharedModel.getSource() === pending.code
    ) ?? -1;
    if (panel !== null && panel !== undefined && index >= 0) {
      panel.content.activeCellIndex = index;
      await NotebookActions.run(panel.content, panel.sessionContext);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const plugin: JupyterFrontEndPlugin<void> = {
  id: "@yurt/jupyterlite-yurt-kernel:plugin",
  autoStart: true,
  requires: [IKernelSpecs, IKernelClient],
  optional: [INotebookTracker],
  activate: (
    _app: JupyterFrontEnd,
    kernelspecs: IKernelSpecs,
    client: IKernelClient,
    tracker: INotebookTracker | null,
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
        const kernel = new YurtKernel(options, bridge);
        kernels.set(options.id, kernel);
        return kernel;
      },
    });
    kernelspecs.register({
      spec: {
        name: "yurt-snapshot",
        display_name: "Python 3 (Yurt, suspend/resume)",
        language: "python",
        argv: [],
        resources: {
          "logo-32x32": "",
          "logo-64x64": "",
        },
      },
      create: async (options: IKernel.IOptions): Promise<IKernel> => {
        const kernel = new YurtKernel(options, snapshotBridge);
        kernels.set(options.id, kernel);
        void kernel.ready.then(async () => {
          await takePendingCell(await snapshotBridge(), tracker, options.id);
        });
        return kernel;
      },
    });
  },
};

export default plugin;
