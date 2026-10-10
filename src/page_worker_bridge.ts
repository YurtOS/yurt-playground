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
  /** Hand the guest its port to the coordinator (true), or relay its
   *  messages through the page as before (false); see
   *  `src/guest_port_policy.ts`. */
  direct: boolean;
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
 *
 * `direct` decides that per guest. With it false the page relays the
 * guest's messages as before: on Safari the direct port only helps once
 * each process reserves less than the whole budget, and measured worse
 * than the relay with 1 GiB reservations (`src/guest_port_policy.ts`).
 */
export function installCoordinatorWorkerProxy(
  direct: () => boolean = () => true,
): void {
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
        direct: direct(),
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
  const { type, url, direct } = data as {
    type?: unknown;
    url?: unknown;
    direct?: unknown;
  };
  if (type !== CREATE_GUEST_WORKER || typeof url !== "string") {
    return undefined;
  }
  // Anything but an explicit `true` relays, the behaviour before #2996.
  return { type: CREATE_GUEST_WORKER, url, direct: direct === true };
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
    let relay: MessageChannel | undefined;
    if (request.direct) {
      guest.postMessage({ type: GUEST_WORKER_PORT }, [guestPort]);
    } else {
      // The relay: the guest still gets a port, but its other end is the
      // page's, which forwards every message both ways.
      relay = new MessageChannel();
      const page = relay.port1;
      page.onmessage = (event) =>
        guestPort.postMessage(event.data, [...event.ports]);
      guestPort.onmessage = (event) =>
        page.postMessage(event.data, [...event.ports]);
      guest.postMessage({ type: GUEST_WORKER_PORT }, [relay.port2]);
    }
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
        if (relay !== undefined) {
          relay.port1.close();
          guestPort.close();
        }
      }
    };
  });
}
