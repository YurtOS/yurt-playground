import type { BrowserPlaygroundSession } from "./boot.ts";
import { GuestHttpError, requestGuestHttp } from "./guest_http.ts";
import type { ExecutionRegistry } from "./executions.ts";
import { appInlineScriptHashes, type Pins } from "./pins.ts";
import { GUEST_APPS, type GuestAppId } from "./guest_apps.ts";
import { SlotQueue } from "./slot_queue.ts";
import {
  type GuestReply,
  type LifecycleReply,
  parseGuestAbort,
  parseGuestRequest,
  parseLifecycleMessage,
} from "./datasette_protocol.ts";
import {
  GuestApp,
  type GuestAppContext,
  type GuestAppSpec,
} from "./guest_app.ts";
export { GuestApp as DatasetteDemo } from "./guest_app.ts";
export const DATASETTE_DIR = "/home/user/demos/datasette";
export const DATASETTE_DB = DATASETTE_DIR + "/orders.db";
export const DATASETTE_QUERY =
  "SELECT product, SUM(quantity * unit_price_cents) AS revenue_cents FROM orders GROUP BY product ORDER BY revenue_cents DESC, product;";
const quote = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'";
async function installSeed(ctx: GuestAppContext) {
  await ctx.finite(
    `mkdir -p ${quote(DATASETTE_DIR)} && exec sh -c ${
      quote(`cat > ${DATASETTE_DIR}/datasette_seed.py`)
    }`,
    await ctx.asset("datasette_seed.py"),
  );
}
export const datasetteSpec: GuestAppSpec = {
  id: "datasette",
  title: "Datasette",
  dir: DATASETTE_DIR,
  async prepare(ctx) {
    await installSeed(ctx);
    await ctx.finite(
      `exec python3 ${quote(DATASETTE_DIR + "/datasette_seed.py")}`,
    );
  },
  async reset(ctx) {
    await installSeed(ctx);
    await ctx.finite(
      `exec python3 ${quote(DATASETTE_DIR + "/datasette_seed.py")} --reset`,
    );
  },
  spawnLine: (prefix, port) =>
    `exec python3 -m datasette serve ${
      quote(DATASETTE_DB)
    } --host 127.0.0.1 --port ${port} --setting base_url ${
      quote(prefix)
    } --setting default_cache_ttl 0`,
  readyPath: (prefix) =>
    prefix + "orders.json?sql=SELECT+1+AS+ready&_shape=array",
  isReady(reply) {
    const headers = new Headers(reply.headers);
    if (
      reply.status !== 200 ||
      !/^application\/json(?:;|$)/i.test(headers.get("content-type") ?? "")
    ) return false;
    const value = JSON.parse(new TextDecoder().decode(reply.body));
    return Array.isArray(value) && value.length === 1 && value[0] !== null &&
      typeof value[0] === "object" && Object.keys(value[0]).length === 1 &&
      value[0].ready === 1;
  },
};

export async function cachedFetch(
  cache: Map<string, Uint8Array>,
  name: string,
  signal: AbortSignal,
): Promise<Uint8Array> {
  signal.throwIfAborted();
  const cached = cache.get(name);
  if (cached) return cached;
  const response = await fetch(`/demo/${name}`, { signal });
  if (!response.ok) {
    throw new Error(`asset download failed: ${response.status}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > 64 * 1024) throw new Error("asset exceeds 64 KiB");
  signal.throwIfAborted();
  cache.set(name, bytes);
  return bytes;
}

export function isConnRefused(error: unknown): boolean {
  return /rc=-111\b/.test(String(error));
}

export function attachGuestApps(
  session: BrowserPlaygroundSession,
  pins: Pins,
  options: {
    executions: ExecutionRegistry;
    send: (
      reply: GuestReply | LifecycleReply,
      transfer?: Transferable[],
    ) => void;
  },
): Map<GuestAppId, GuestApp> {
  const apps = new Map<GuestAppId, GuestApp>();
  const queue = new SlotQueue();
  const assets = new Map<string, Uint8Array>();
  for (const spec of [datasetteSpec]) {
    if (appInlineScriptHashes(pins, spec.id) === undefined) continue;
    const port = session.guestPorts[spec.id];
    apps.set(
      spec.id,
      new GuestApp(spec, {
        queue,
        uuid: () => crypto.randomUUID(),
        now: () => performance.now(),
        servicePort: port,
        delay: (ms, signal) =>
          new Promise<void>((resolve, reject) => {
            signal?.throwIfAborted();
            const abort = () => {
              clearTimeout(timer);
              reject(signal?.reason);
            };
            const timer = setTimeout(() => {
              signal?.removeEventListener("abort", abort);
              resolve();
            }, ms);
            signal?.addEventListener("abort", abort, { once: true });
          }),
        spawn: (line) => session.spawn(line),
        finite: async (line, stdin, timeoutMs) => {
          const id = await options.executions.spawn(line, {
            stdin,
            timeoutMs: timeoutMs ?? 120_000,
            maxOutputBytes: 8192,
          });
          const result = await options.executions.wait(id);
          return {
            code: "code" in result && result.code !== null ? result.code : -1,
            stdout: result.stdout,
            stderr: result.stderr,
          };
        },
        asset: (name, signal) => cachedFetch(assets, name, signal),
        portBusy: async () => {
          try {
            const connection = await session.dialSandboxPort(port);
            await connection.close();
            return true;
          } catch (error) {
            if (isConnRefused(error)) return false;
            throw error;
          }
        },
        request: (request) =>
          requestGuestHttp(
            () =>
              Promise.resolve(
                session.dialSandboxPort(port),
              ),
            { ...request, port },
          ),
        changed: (snapshot) =>
          options.send({ type: "datasette-state", app: spec.id, snapshot }),
      }),
    );
  }
  return apps;
}

export async function handleGuestAppMessage(
  apps: Map<GuestAppId, GuestApp> | undefined,
  value: unknown,
  send: (reply: GuestReply | LifecycleReply, transfer?: Transferable[]) => void,
): Promise<boolean> {
  const lifecycle = parseLifecycleMessage(value);
  if (lifecycle) {
    const demo = apps?.get(lifecycle.app);
    try {
      if (!demo) {
        throw new Error(
          `${
            GUEST_APPS[lifecycle.app].title
          } requires a qualified browser image`,
        );
      }
      const snapshot = await (lifecycle.type === "datasette-start"
        ? demo.start()
        : lifecycle.type === "datasette-stop"
        ? demo.stop()
        : demo.reset());
      send({
        type: "datasette-state",
        app: lifecycle.app,
        requestId: lifecycle.requestId,
        snapshot,
      });
    } catch (error) {
      send({
        type: "datasette-state",
        app: lifecycle.app,
        requestId: lifecycle.requestId,
        snapshot: demo?.snapshot.state === "stuck" ? demo.snapshot : {
          state: "failed",
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }
    return true;
  }
  const abort = parseGuestAbort(value);
  if (abort) {
    for (const demo of apps?.values() ?? []) {
      demo.abort(abort.session, abort.requestId);
    }
    return true;
  }
  const request = parseGuestRequest(value);
  if (!request) return false;
  const demo = apps?.get(request.app);
  try {
    if (!demo) {
      throw new GuestHttpError(
        `${GUEST_APPS[request.app].title} requires a qualified browser image`,
        503,
      );
    }
    const reply = await demo.request(request);
    send({
      type: "datasette-response",
      session: request.session,
      requestId: request.requestId,
      ...reply,
    }, [reply.body]);
  } catch (error) {
    send({
      type: "datasette-error",
      session: request.session,
      requestId: request.requestId,
      code: error instanceof GuestHttpError
        ? error.status
        : error instanceof DOMException
        ? 503
        : 502,
      message: error instanceof Error ? error.message : String(error),
    });
  }
  return true;
}
