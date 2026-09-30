import { guestWorkerStart } from "./guest_worker.ts";
export const CREATE_GUEST_WORKER = "yurt-create-guest-worker";
export const TERMINATE_GUEST_WORKER = "yurt-terminate";
export const GUEST_WORKER_ERROR = "yurt-guest-worker-error";
/** The page's first and only message to a guest: the port to its host. */
export const GUEST_WORKER_PORT = "yurt-guest-worker-port";

export type CreateGuestWorkerMessage = {
  type: typeof CREATE_GUEST_WORKER;
  url: string;
  options?: WorkerOptions;
};

type GuestWorkerErrorMessage = {
  type: typeof GUEST_WORKER_ERROR;
  message: string;
};

function isGuestWorkerErrorMessage(
  value: unknown,
): value is GuestWorkerErrorMessage {
  return value !== null && typeof value === "object" &&
    (value as { type?: unknown }).type === GUEST_WORKER_ERROR;
}

export function dispatchGuestWorkerProxyEvent(
  target: EventTarget,
  event: MessageEvent,
): void {
  if (isGuestWorkerErrorMessage(event.data)) {
    target.dispatchEvent(
      new ErrorEvent("error", { message: event.data.message }),
    );
    return;
  }
  target.dispatchEvent(
    new MessageEvent("message", {
      data: event.data,
      ports: [...event.ports],
    }),
  );
}

/**
 * WorkerHost.spawnRootLeader does `new Worker` then immediately
 * `Atomics.wait`. A nested Worker created on that same coordinator
 * cannot start until the wait returns — deadlock. Create the guest
 * on the page, whose event loop is free.
 *
 * The page only creates and terminates the guest. Its messages travel on
 * a port straight from this coordinator to the guest (see
 * {@link adoptGuestPort}), because they carry the guest's shared
 * `WebAssembly.Memory`: WebKit frees one only when every heap that saw it
 * has collected it, and a Memory relayed through the page also lived in
 * the page's heap. A failed allocation here collects only this heap, so
 * Safari ran out of memory for new processes after about 36 (#2996).
 */
export function installCoordinatorWorkerProxy(): void {
  self.Worker = class PageBackedWorker extends EventTarget {
    #port: MessagePort;
    #control: MessagePort;

    constructor(scriptURL: string | URL, options?: WorkerOptions) {
      super();
      // To the guest itself, and to the page for its lifecycle.
      const guest = new MessageChannel();
      const control = new MessageChannel();
      this.#port = guest.port1;
      this.#control = control.port1;
      this.#port.onmessage = (event) => {
        dispatchGuestWorkerProxyEvent(this, event);
      };
      this.#port.onmessageerror = () => {
        this.dispatchEvent(new Event("error"));
      };
      this.#control.onmessage = (event) => {
        dispatchGuestWorkerProxyEvent(this, event);
      };
      const message: CreateGuestWorkerMessage = {
        type: CREATE_GUEST_WORKER,
        url: String(scriptURL),
        options,
      };
      self.postMessage(message, {
        transfer: [guest.port2, control.port2],
      });
    }

    postMessage(data: unknown, transfer?: Transferable[]): void {
      this.#port.postMessage(data, transfer ?? []);
    }

    terminate(): void {
      this.#control.postMessage({ type: TERMINATE_GUEST_WORKER });
      this.#control.close();
      this.#port.close();
    }
  } as unknown as typeof Worker;
}

type GuestScope = {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage: (message: unknown, transfer?: Transferable[]) => void;
};

/**
 * Run in the guest Worker after its bootstrap has installed `onmessage`:
 * wait for the page's {@link GUEST_WORKER_PORT} message, then serve the
 * bootstrap from that port and send everything it posts back on it.
 * Messages the coordinator sent before the port arrived wait in the port.
 */
export function adoptGuestPort(scope: GuestScope): void {
  const bootstrap = scope.onmessage;
  scope.onmessage = (event) => {
    const port = event.ports[0];
    if (
      port === undefined ||
      (event.data as { type?: unknown } | null)?.type !== GUEST_WORKER_PORT
    ) {
      return;
    }
    scope.onmessage = null;
    scope.postMessage = (message, transfer) =>
      port.postMessage(message, transfer ?? []);
    port.onmessage = (portEvent) => bootstrap?.(portEvent);
  };
}

/** The create request, or `undefined` for anything else on the channel. */
export function parseCreateGuestWorkerMessage(
  data: unknown,
): CreateGuestWorkerMessage | undefined {
  if (data === null || typeof data !== "object") return undefined;
  const { type, url } = data as { type?: unknown; url?: unknown };
  if (type !== CREATE_GUEST_WORKER || typeof url !== "string") {
    return undefined;
  }
  return { type: CREATE_GUEST_WORKER, url };
}

export function attachGuestWorkerFactory(coordinator: Worker): void {
  coordinator.addEventListener("message", (event: MessageEvent) => {
    const request = parseCreateGuestWorkerMessage(event.data);
    if (request === undefined) return;
    const [guestPort, control] = event.ports;
    if (guestPort === undefined || control === undefined) return;
    const fail = (message: string) =>
      control.postMessage(
        { type: GUEST_WORKER_ERROR, message } satisfies GuestWorkerErrorMessage,
      );
    // The page creates the Worker the coordinator asked for, but only the
    // one it is allowed to ask for: the same-origin bootstrap. A refusal is
    // reported over the control port as a worker error, so the requesting
    // WorkerHost sees a failed spawn rather than silence.
    let start: [string, WorkerOptions];
    try {
      start = guestWorkerStart(request.url, self.location.origin);
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
      control.close();
      return;
    }
    const guest = new Worker(...start);
    guest.postMessage({ type: GUEST_WORKER_PORT }, [guestPort]);
    guest.onerror = (event) => {
      fail(event.message || "guest worker failed");
    };
    control.onmessage = (controlEvent) => {
      if (
        (controlEvent.data as { type?: string } | null)?.type ===
          TERMINATE_GUEST_WORKER
      ) {
        guest.terminate();
        control.close();
      }
    };
  });
}
