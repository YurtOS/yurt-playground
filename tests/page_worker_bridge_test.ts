import { assertEquals } from "@std/assert";
import {
  adoptGuestPort,
  attachGuestWorkerFactory,
  CREATE_GUEST_WORKER,
  dispatchGuestWorkerProxyEvent,
  GUEST_WORKER_ERROR,
  GUEST_WORKER_PORT,
  installCoordinatorWorkerProxy,
  parseCreateGuestWorkerMessage,
} from "../src/page_worker_bridge.ts";

Deno.test("guest-worker factory messages use a reserved type", () => {
  assertEquals(CREATE_GUEST_WORKER, "yurt-create-guest-worker");
});

Deno.test("guest-worker failures become proxy error events", () => {
  const proxy = new EventTarget();
  let messageEvents = 0;
  let errorMessage = "";
  proxy.addEventListener("message", () => messageEvents++);
  proxy.addEventListener("error", (event) => {
    errorMessage = (event as ErrorEvent).message;
  });

  dispatchGuestWorkerProxyEvent(
    proxy,
    new MessageEvent("message", {
      data: { type: GUEST_WORKER_ERROR, message: "guest failed to load" },
    }),
  );

  assertEquals(messageEvents, 0);
  assertEquals(errorMessage, "guest failed to load");
});

/**
 * Wires `installCoordinatorWorkerProxy` (the coordinator's `Worker`) to
 * `attachGuestWorkerFactory` (the page) in one process, with a fake guest
 * Worker standing in for the real one. The guest runs `bootstrap`, a
 * stand-in for the kernel's worker bootstrap: it installs `onmessage` on its
 * scope and answers with the scope's `postMessage`.
 */
function wireBridge(
  bootstrap: (scope: GuestScope) => void,
  direct = true,
) {
  const originalWorker = globalThis.Worker;
  const originalPostMessage = (globalThis as { postMessage?: unknown })
    .postMessage;
  // The page's origin, which the factory checks the bootstrap URL against.
  const originalLocation = Object.getOwnPropertyDescriptor(
    globalThis,
    "location",
  );
  Object.defineProperty(globalThis, "location", {
    value: new URL("http://127.0.0.1:4173/"),
    configurable: true,
  });
  // The page's handle on the coordinator Worker.
  const coordinator = new EventTarget();
  (globalThis as { postMessage?: unknown }).postMessage = (
    data: unknown,
    options?: { transfer?: Transferable[] },
  ) => {
    const ports = (options?.transfer ?? []) as MessagePort[];
    queueMicrotask(() =>
      coordinator.dispatchEvent(new MessageEvent("message", { data, ports }))
    );
  };
  installCoordinatorWorkerProxy(() => direct);
  const ProxyWorker = globalThis.Worker;
  const guests: FakeGuestWorker[] = [];
  class FakeGuestWorker {
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: ((event: ErrorEvent) => void) | null = null;
    terminated = false;
    /** Everything the page itself handed this Worker. */
    readonly fromPage: unknown[] = [];
    readonly scope: GuestScope;
    constructor() {
      guests.push(this);
      this.scope = {
        onmessage: null,
        postMessage: (data: unknown, transfer?: Transferable[]) => {
          queueMicrotask(() =>
            this.onmessage?.(
              new MessageEvent("message", {
                data,
                ports: (transfer ?? []) as MessagePort[],
              }),
            )
          );
        },
      };
      bootstrap(this.scope);
    }
    postMessage(data: unknown, transfer?: Transferable[]): void {
      this.fromPage.push(data);
      const ports = (transfer ?? []) as MessagePort[];
      queueMicrotask(() =>
        this.scope.onmessage?.(new MessageEvent("message", { data, ports }))
      );
    }
    terminate(): void {
      this.terminated = true;
    }
  }
  (globalThis as { Worker: unknown }).Worker = FakeGuestWorker;
  attachGuestWorkerFactory(coordinator as unknown as Worker);
  const restore = () => {
    (globalThis as { Worker: unknown }).Worker = originalWorker;
    (globalThis as { postMessage?: unknown }).postMessage = originalPostMessage;
    if (originalLocation) {
      Object.defineProperty(globalThis, "location", originalLocation);
    } else {
      delete (globalThis as { location?: unknown }).location;
    }
  };
  return { ProxyWorker, guests, restore };
}

type GuestScope = {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage: (data: unknown, transfer?: Transferable[]) => void;
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

/** The kernel bootstrap's shape: answer each message on the scope. */
function echoBootstrap(scope: GuestScope): void {
  scope.onmessage = (event) =>
    scope.postMessage({ echo: (event.data as { kind: string }).kind });
}

Deno.test({
  name:
    "a guest's messages go straight to the coordinator, never through the page",
  // The fake guest cannot close the port a real terminate() tears down.
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  // #2996: WebKit frees a guest's shared memory only once every heap that
  // saw its WebAssembly.Memory has collected it. Relayed through the page,
  // each memory also lived in the page's heap, which the coordinator's
  // allocation failure does not collect, and Safari ran out after ~36
  // processes. Only the port that connects them may cross the page.
  const { ProxyWorker, guests, restore } = wireBridge((scope) => {
    // As in src/guest_worker_entry.ts: the bootstrap first, then the port.
    echoBootstrap(scope);
    adoptGuestPort(scope);
  });
  try {
    const worker = new ProxyWorker("/worker_bootstrap.js", { type: "module" });
    const replies: unknown[] = [];
    worker.addEventListener("message", (event) => {
      replies.push((event as MessageEvent).data);
    });
    const memory = new WebAssembly.Memory({
      initial: 1,
      maximum: 1,
      shared: true,
    });
    worker.postMessage({ kind: "init", memory });
    await settle();
    assertEquals(replies, [{ echo: "init" }]);
    assertEquals(guests.length, 1);
    assertEquals(guests[0].fromPage, [{ type: GUEST_WORKER_PORT }]);

    worker.terminate();
    await settle();
    assertEquals(guests[0].terminated, true);
  } finally {
    restore();
  }
});

Deno.test({
  name: "a guest's load failure still reaches the coordinator as an error",
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const { ProxyWorker, guests, restore } = wireBridge((scope) => {
    adoptGuestPort(scope);
  });
  try {
    const worker = new ProxyWorker("/worker_bootstrap.js", { type: "module" });
    let errorMessage = "";
    worker.addEventListener("error", (event) => {
      errorMessage = (event as ErrorEvent).message;
    });
    await settle();
    guests[0].onerror?.(
      new ErrorEvent("error", { message: "bootstrap failed to load" }),
    );
    await settle();
    assertEquals(errorMessage, "bootstrap failed to load");
    worker.terminate();
  } finally {
    restore();
  }
});

Deno.test({
  name: "with the relay, a guest's messages still reach the coordinator",
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  // Safari before the per-process reservation is in effect: the page keeps
  // relaying (src/guest_port_policy.ts).
  const { ProxyWorker, guests, restore } = wireBridge((scope) => {
    echoBootstrap(scope);
    adoptGuestPort(scope);
  }, false);
  try {
    const worker = new ProxyWorker("/worker_bootstrap.js", { type: "module" });
    const replies: unknown[] = [];
    worker.addEventListener("message", (event) => {
      replies.push((event as MessageEvent).data);
    });
    worker.postMessage({ kind: "init" });
    worker.postMessage({ kind: "relay" });
    await settle();
    assertEquals(replies, [{ echo: "init" }, { echo: "relay" }]);
    assertEquals(guests[0].fromPage, [{ type: GUEST_WORKER_PORT }]);
    worker.terminate();
    await settle();
    assertEquals(guests[0].terminated, true);
  } finally {
    restore();
  }
});

Deno.test("the create request carries the coordinator's direct-port choice", () => {
  const base = { type: CREATE_GUEST_WORKER, url: "/worker_bootstrap.js" };
  assertEquals(
    parseCreateGuestWorkerMessage({ ...base, direct: true })?.direct,
    true,
  );
  assertEquals(
    parseCreateGuestWorkerMessage({ ...base, direct: false })?.direct,
    false,
  );
  // An older coordinator says nothing: relay, as before.
  assertEquals(parseCreateGuestWorkerMessage(base)?.direct, false);
});
