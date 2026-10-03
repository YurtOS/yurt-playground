import { DatasetteRoutes, type OwnerClient } from "./datasette_routes.ts";
import { parseOwnerMessage } from "./datasette_protocol.ts";
interface LifetimeEvent {
  waitUntil(promise: Promise<unknown>): void;
}
interface WorkerClients {
  get(id: string): Promise<OwnerClient | undefined>;
  matchAll(
    options: { type: "window"; includeUncontrolled: boolean },
  ): Promise<OwnerClient[]>;
  claim(): Promise<void>;
}
interface DatasetteWorkerGlobal {
  location: { origin: string };
  clients: WorkerClients;
  skipWaiting(): Promise<void>;
  addEventListener(
    type: "install" | "activate",
    handler: (event: LifetimeEvent) => void,
  ): void;
  addEventListener(
    type: "message",
    handler: (event: MessageEvent & LifetimeEvent) => void,
  ): void;
  addEventListener(
    type: "fetch",
    handler: (
      event: LifetimeEvent & {
        request: Request;
        respondWith(promise: Promise<Response>): void;
      },
    ) => void,
  ): void;
}
const worker = self as unknown as DatasetteWorkerGlobal;
const routes = new DatasetteRoutes({
  origin: worker.location.origin,
  client: (id) => worker.clients.get(id),
  owners: () =>
    worker.clients.matchAll({ type: "window", includeUncontrolled: true }),
});
worker.addEventListener(
  "install",
  (event) => event.waitUntil(worker.skipWaiting()),
);
worker.addEventListener(
  "activate",
  (event) => event.waitUntil(worker.clients.claim()),
);
worker.addEventListener("message", (event) => {
  const msg = parseOwnerMessage(event.data);
  const source = event.source as unknown as { id?: string } | null;
  if (!msg || !source?.id) return;
  const port = event.ports[0];
  const handle = (async () => {
    const client = await worker.clients.get(source.id!);
    if (!client) {
      port?.close();
      return;
    }
    if (msg.type === "datasette-register" && port) {
      try {
        await routes.register(client, msg, port);
      } catch {
        port.close();
      }
    } else if (msg.type === "datasette-unregister") {
      routes.unregister(client.id, msg.session);
    } else if (msg.type === "datasette-ping") {
      if (routes.ping(client, msg)) {
        client.postMessage({
          type: "datasette-pong",
          session: msg.session,
          nonce: msg.nonce,
        });
      }
    }
  })();
  event.waitUntil(handle);
});
worker.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (
    url.origin !== worker.location.origin ||
    !url.pathname.startsWith("/apps/datasette/") ||
    url.pathname === "/apps/datasette/service-worker.js" ||
    url.pathname === "/apps/datasette/unavailable.html"
  ) return;
  const response = routes.respond(event.request);
  event.respondWith(response);
  event.waitUntil(response.then(() => {}));
});
