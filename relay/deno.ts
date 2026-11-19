/**
 * The relay under Deno: what the playground's tests run, and a way to run
 * one locally.
 *
 *   RELAY_SECRET=... RELAY_ORIGINS=http://127.0.0.1:4173 \
 *     deno run --allow-net --allow-env relay/deno.ts [port]
 */
import {
  createRelay,
  type Limits,
  type RelayConnection,
  type RelayWebSocket,
} from "./relay.ts";

/** A server WebSocket that queues `send`/`close` until it is open: Deno
 * refuses both while the handshake is still going out. */
function openWhenReady(socket: WebSocket): RelayWebSocket {
  socket.binaryType = "arraybuffer";
  let ready = socket.readyState === WebSocket.OPEN;
  const queued: (() => void)[] = [];
  socket.addEventListener("open", () => {
    ready = true;
    for (const action of queued.splice(0)) action();
  });
  const when = (action: () => void) => ready ? action() : queued.push(action);
  return {
    send: (data) => when(() => socket.send(data)),
    close: (code, reason) =>
      when(() => {
        if (socket.readyState === WebSocket.OPEN) socket.close(code, reason);
      }),
    addEventListener: (type: string, listener: (event: never) => void) =>
      socket.addEventListener(type, listener as EventListener),
  } as RelayWebSocket;
}

export type DenoRelayOptions = {
  secret: string;
  allowedOrigins: string[];
  port?: number;
  limits?: Partial<Limits>;
  /** Overrides for tests: resolution and connects. */
  resolve?: (name: string) => Promise<string[]>;
  connect?: (ip: string, port: number) => Promise<RelayConnection>;
};

export function startDenoRelay(options: DenoRelayOptions) {
  const relay = createRelay({
    secret: options.secret,
    allowedOrigins: options.allowedOrigins,
    limits: options.limits,
    resolve: options.resolve ??
      (async (name) => {
        try {
          return await Deno.resolveDns(name, "A");
        } catch (error) {
          if (error instanceof Deno.errors.NotFound) return [];
          throw error;
        }
      }),
    connect: options.connect ??
      (async (ip, port) => {
        const conn = await Deno.connect({ hostname: ip, port });
        return {
          readable: conn.readable,
          writable: conn.writable,
          close: () => conn.close(),
        };
      }),
    upgrade: (request) => {
      const { socket, response } = Deno.upgradeWebSocket(request);
      return { socket: openWhenReady(socket), response };
    },
  });
  const server = Deno.serve(
    { port: options.port ?? 0, hostname: "127.0.0.1", onListen: () => {} },
    relay.handle,
  );
  const addr = server.addr as Deno.NetAddr;
  return {
    url: `http://127.0.0.1:${addr.port}`,
    usage: relay.usage,
    shutdown: () => server.shutdown(),
  };
}

if (import.meta.main) {
  const secret = Deno.env.get("RELAY_SECRET");
  const origins = Deno.env.get("RELAY_ORIGINS");
  if (!secret || !origins) {
    console.error("set RELAY_SECRET and RELAY_ORIGINS (comma-separated)");
    Deno.exit(2);
  }
  const relay = startDenoRelay({
    secret,
    allowedOrigins: origins.split(",").map((o) => o.trim()),
    port: Number(Deno.args[0] ?? 8788),
  });
  console.log(`relay on ${relay.url}`);
}
