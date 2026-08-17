export const CREATE_GUEST_WORKER = "yurt-create-guest-worker";
export const TERMINATE_GUEST_WORKER = "yurt-terminate";

export type CreateGuestWorkerMessage = {
  type: typeof CREATE_GUEST_WORKER;
  url: string;
  options?: WorkerOptions;
};

/**
 * WorkerHost.spawnRootLeader does `new Worker` then immediately
 * `Atomics.wait`. A nested Worker created on that same coordinator
 * cannot start until the wait returns — deadlock. Create the guest
 * on the page, whose event loop is free, and proxy messages.
 */
export function installCoordinatorWorkerProxy(): void {
  self.Worker = class PageBackedWorker extends EventTarget {
    #port: MessagePort;

    constructor(scriptURL: string | URL, options?: WorkerOptions) {
      super();
      const channel = new MessageChannel();
      this.#port = channel.port1;
      this.#port.onmessage = (event) => {
        this.dispatchEvent(
          new MessageEvent("message", {
            data: event.data,
            ports: [...event.ports],
          }),
        );
      };
      this.#port.onmessageerror = () => {
        this.dispatchEvent(new Event("error"));
      };
      const message: CreateGuestWorkerMessage = {
        type: CREATE_GUEST_WORKER,
        url: String(scriptURL),
        options,
      };
      self.postMessage(message, [channel.port2]);
    }

    postMessage(data: unknown, transfer?: Transferable[]): void {
      this.#port.postMessage(data, transfer ?? []);
    }

    terminate(): void {
      this.#port.postMessage({ type: TERMINATE_GUEST_WORKER });
      this.#port.close();
    }
  } as unknown as typeof Worker;
}

export function attachGuestWorkerFactory(coordinator: Worker): void {
  coordinator.addEventListener("message", (event: MessageEvent) => {
    const msg = event.data as CreateGuestWorkerMessage | { type?: string };
    if (msg?.type !== CREATE_GUEST_WORKER) return;
    const request = msg as CreateGuestWorkerMessage;
    const port = event.ports[0];
    if (port === undefined) return;
    const guest = new Worker(request.url, request.options);
    guest.onmessage = (guestEvent) => {
      port.postMessage(guestEvent.data, [...guestEvent.ports]);
    };
    guest.onerror = () => {
      port.postMessage({ type: "error" });
    };
    port.onmessage = (portEvent) => {
      if (
        portEvent.data !== null &&
        typeof portEvent.data === "object" &&
        (portEvent.data as { type?: string }).type === TERMINATE_GUEST_WORKER
      ) {
        guest.terminate();
        port.close();
        return;
      }
      guest.postMessage(portEvent.data, [...portEvent.ports]);
    };
  });
}
