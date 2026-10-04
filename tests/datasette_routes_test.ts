// deno-lint-ignore-file require-await
import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
  DatasetteRoutes,
  DEFAULT_REQUEST_TIMEOUT_MS,
} from "../src/datasette_routes.ts";
import { parseGuestRequest } from "../src/datasette_protocol.ts";
import { REQUEST_DEADLINE_MS } from "../src/slot_queue.ts";
const session = "11111111-1111-4111-8111-111111111111",
  prefix = `/apps/datasette/${session}/`;
const origin = "http://playground";
const previewPrefix = `/apps/preview/${session}/`;
const hashes = ["sha256-" + "A".repeat(43) + "="];
const client = {
  id: "owner",
  url: "http://playground/",
  postMessage: () => {},
};
function browserRequest(
  url: string,
  init: RequestInit & { destination?: string } = {},
): Request {
  const { referrer = "", referrerPolicy = "", destination = "", ...rest } =
    init;
  return Object.defineProperties(new Request(url, rest), {
    referrer: { value: referrer },
    referrerPolicy: { value: referrerPolicy },
    destination: { value: destination },
  });
}
function makeRoutes(
  options: {
    requestTimeoutMs?: number;
    ownerDelayMs?: number;
    replyHeaders?: [string, string][];
  } = {},
) {
  const received: Record<string, unknown>[] = [];
  const logged: string[] = [];
  const timers: number[] = [];
  const channel = new MessageChannel();
  const routes = new DatasetteRoutes({
    origin,
    client: async (id) => id === client.id ? client : undefined,
    owners: async () => [client],
    requestTimeoutMs: options.requestTimeoutMs,
    log: (message) => logged.push(message),
  });
  channel.port2.onmessage = (event) => {
    if (event.data.type !== "datasette-http") return;
    received.push(event.data);
    timers.push(setTimeout(() =>
      channel.port2.postMessage({
        type: "datasette-response",
        session,
        requestId: event.data.requestId,
        status: 204,
        headers: options.replyHeaders ?? [],
        body: new ArrayBuffer(0),
      }), options.ownerDelayMs ?? 0));
  };
  return {
    routes,
    received,
    logged,
    register: () =>
      routes.register(client, {
        type: "datasette-register",
        app: "preview",
        session,
        prefix: previewPrefix,
        nonce: "n",
        hashes,
      }, channel.port1),
    close: () => {
      for (const timer of timers) clearTimeout(timer);
      routes.dispose();
      channel.port1.close();
      channel.port2.close();
    },
  };
}
const get = () => browserRequest(origin + previewPrefix + "x");
const documentRequest = () =>
  browserRequest(origin + previewPrefix, { destination: "document" });
function fixture() {
  const routes = new DatasetteRoutes({
    origin: "http://playground",
    client: async (id) => id === "owner" ? client : undefined,
    owners: async () => [client],
    requestTimeoutMs: 30,
    recoveryMs: 10,
  });
  const channel = new MessageChannel();
  return {
    routes,
    channel,
    close: () => {
      routes.dispose();
      channel.port1.close();
      channel.port2.close();
    },
  };
}
Deno.test("Datasette routes bind replies to the registered owner channel", async () => {
  const f = fixture();
  try {
    await f.routes.register(client, {
      type: "datasette-register",
      app: "datasette",
      session,
      prefix,
      nonce: "n",
      hashes,
    }, f.channel.port1);
    f.channel.port2.onmessage = (e) => {
      if (e.data.type === "datasette-http") {
        f.channel.port2.postMessage({
          type: "datasette-response",
          session,
          requestId: e.data.requestId,
          status: 200,
          headers: [["content-type", "text/plain"]],
          body: new TextEncoder().encode("guest bytes").buffer,
        });
      }
    };
    const response = await f.routes.respond(
      new Request("http://playground" + prefix + "orders"),
    );
    assertEquals(await response.text(), "guest bytes");
    assertEquals(
      response.headers.get("cross-origin-embedder-policy"),
      "require-corp",
    );
  } finally {
    f.close();
  }
});
Deno.test("a different app path cannot evict the registered owner", async () => {
  const f = fixture();
  try {
    await f.routes.register(client, {
      type: "datasette-register",
      app: "datasette",
      session,
      prefix,
      nonce: "n",
      hashes,
    }, f.channel.port1);
    f.channel.port2.onmessage = (e) => {
      if (e.data.type === "datasette-http") {
        f.channel.port2.postMessage({
          type: "datasette-response",
          session,
          requestId: e.data.requestId,
          status: 204,
          headers: [],
          body: new ArrayBuffer(0),
        });
      }
    };
    assertEquals((await f.routes.respond(get())).status, 503);
    assertEquals(
      (await f.routes.respond(browserRequest(origin + prefix))).status,
      204,
    );
  } finally {
    f.close();
  }
});
Deno.test("Datasette routes reject a foreign owner claiming an existing session", async () => {
  const f = fixture();
  const extra = new MessageChannel();
  try {
    await f.routes.register(client, {
      type: "datasette-register",
      app: "datasette",
      session,
      prefix,
      nonce: "n",
      hashes,
    }, f.channel.port1);
    await assertRejects(() =>
      f.routes.register({ ...client, id: "other" }, {
        type: "datasette-register",
        app: "datasette",
        session,
        prefix,
        nonce: "n",
        hashes,
      }, extra.port1)
    );
  } finally {
    f.close();
    extra.port1.close();
    extra.port2.close();
  }
});
Deno.test("Datasette routes reject unreferenced POST before contacting the owner and omit HEAD errors", async () => {
  const f = fixture();
  try {
    assertEquals(
      (await f.routes.respond(
        new Request("http://playground" + prefix, {
          method: "POST",
          body: "write",
        }),
      )).status,
      403,
    );
    const head = await f.routes.respond(
      new Request("http://playground" + prefix, { method: "HEAD" }),
    );
    assertEquals(head.status, 503);
    assertEquals(await head.text(), "");
  } finally {
    f.close();
  }
});
Deno.test("Datasette unregister cancels pending requests and ignores stale replies", async () => {
  const f = fixture();
  try {
    await f.routes.register(client, {
      type: "datasette-register",
      app: "datasette",
      session,
      prefix,
      nonce: "n",
      hashes,
    }, f.channel.port1);
    const seen = Promise.withResolvers<void>();
    f.channel.port2.onmessage = (e) => {
      if (e.data.type === "datasette-http") seen.resolve();
    };
    const response = f.routes.respond(
      new Request("http://playground" + prefix),
    );
    await seen.promise;
    f.routes.unregister(client.id, session);
    assertEquals((await response).status, 503);
  } finally {
    f.close();
  }
});
Deno.test("Datasette worker recovery finds the exact uncontrolled root owner", async () => {
  const channel = new MessageChannel();
  const c = {
    ...client,
    postMessage: (value: unknown) => {
      const msg = value as { session: string; nonce: string };
      void routes.register(c, {
        type: "datasette-register",
        app: "datasette",
        session: msg.session,
        prefix,
        nonce: msg.nonce,
        hashes,
      }, channel.port1);
    },
  };
  const routes = new DatasetteRoutes({
    origin: "http://playground",
    client: async () => c,
    owners: async () => [c],
    recoveryMs: 5,
  });
  channel.port2.onmessage = (e) => {
    if (e.data.type === "datasette-http") {
      channel.port2.postMessage({
        type: "datasette-response",
        session,
        requestId: e.data.requestId,
        status: 200,
        headers: [],
        body: new TextEncoder().encode("recovered").buffer,
      });
    }
  };
  try {
    assertEquals(
      await (await routes.respond(new Request("http://playground" + prefix)))
        .text(),
      "recovered",
    );
  } finally {
    routes.dispose();
    channel.port1.close();
    channel.port2.close();
  }
});
Deno.test("Datasette worker recovery refuses multiple root owner claims", async () => {
  const channels = [new MessageChannel(), new MessageChannel()];
  const clients = channels.map((channel, i) => ({
    ...client,
    id: "owner" + i,
    postMessage: (value: unknown) => {
      const msg = value as { nonce: string };
      void routes.register(clients[i], {
        type: "datasette-register",
        app: "datasette",
        session,
        prefix,
        nonce: msg.nonce,
        hashes,
      }, channel.port1).catch(() => {});
    },
  }));
  const routes = new DatasetteRoutes({
    origin: "http://playground",
    client: async (id) => clients.find((c) => c.id === id),
    owners: async () => clients,
    recoveryMs: 5,
  });
  try {
    assertEquals(
      (await routes.respond(new Request("http://playground" + prefix))).status,
      503,
    );
  } finally {
    routes.dispose();
    for (const c of channels) {
      c.port1.close();
      c.port2.close();
    }
  }
});
Deno.test("concurrent recovery requests wait for all owner claims", async () => {
  const channels = [new MessageChannel(), new MessageChannel()];
  let claim!: () => void;
  const firstClaim = new Promise<void>((resolve) => claim = resolve);
  const clients = channels.map((channel, i) => ({
    ...client,
    id: `owner${i}`,
    postMessage: (value: unknown) => {
      const msg = value as { nonce: string };
      const register = () =>
        routes.register(clients[i], {
          type: "datasette-register",
          app: "datasette",
          session,
          prefix,
          nonce: msg.nonce,
          hashes,
        }, channel.port1).then(() => claim()).catch(() => {});
      if (i === 0) void register();
      else setTimeout(() => void register(), 10);
    },
  }));
  const routes = new DatasetteRoutes({
    origin: "http://playground",
    client: async (id) => clients.find((c) => c.id === id),
    owners: async () => clients,
    recoveryMs: 20,
  });
  channels[0].port2.onmessage = (e) => {
    if (e.data.type === "datasette-http") {
      channels[0].port2.postMessage({
        type: "datasette-response",
        session,
        requestId: e.data.requestId,
        status: 200,
        headers: [],
        body: new ArrayBuffer(0),
      });
    }
  };
  try {
    const first = routes.respond(new Request("http://playground" + prefix));
    await firstClaim;
    const second = routes.respond(new Request("http://playground" + prefix));
    assertEquals((await second).status, 503);
    assertEquals((await first).status, 503);
  } finally {
    routes.dispose();
    for (const c of channels) {
      c.port1.close();
      c.port2.close();
    }
  }
});
Deno.test("request cancellation settles promptly while recovering a missing owner", async () => {
  const routes = new DatasetteRoutes({
    origin: "http://playground",
    client: async () => undefined,
    owners: async () => [],
    recoveryMs: 1000,
  });
  const controller = new AbortController();
  let timer: number | undefined;
  try {
    const response = routes.respond(
      new Request("http://playground" + prefix, { signal: controller.signal }),
    );
    controller.abort();
    const timeout = new Promise<never>((_, reject) =>
      timer = setTimeout(
        () => reject(new Error("cancel waited for discovery")),
        50,
      )
    );
    assertEquals((await Promise.race([response, timeout])).status, 503);
  } finally {
    clearTimeout(timer);
    routes.dispose();
  }
});

Deno.test("POST forwards body, mapped referrer and allow-listed headers", async () => {
  const f = makeRoutes();
  try {
    await f.register();
    const res = await f.routes.respond(
      browserRequest(`${origin}${previewPrefix}form`, {
        method: "POST",
        body: new Uint8Array([1, 2, 3]),
        headers: {
          "content-type": "application/octet-stream",
          cookie: "no",
          "x-csrf-token": "t",
          "x-secret": "no",
        },
        referrer: `${origin}${previewPrefix}page?x=1`,
      }),
    );
    assertEquals(res.status, 204);
    const forwarded = f.received[0];
    assertEquals(forwarded.app, "preview");
    assertEquals(forwarded.method, "POST");
    assertEquals(
      new Uint8Array(forwarded.body as ArrayBuffer),
      new Uint8Array([1, 2, 3]),
    );
    assertEquals(forwarded.referrer, `${previewPrefix}page?x=1`);
    assertEquals(
      (forwarded.headers as [string, string][]).map(([k]) => k.toLowerCase())
        .sort(),
      ["content-type", "x-csrf-token"],
    );
  } finally {
    f.close();
  }
});

Deno.test("cross-site, empty and invalid unsafe referrers are 403; GET is unaffected", async () => {
  const f = makeRoutes();
  try {
    await f.register();
    for (const referrer of ["https://evil.test/", "", "about:client"]) {
      const res = await f.routes.respond(
        browserRequest(`${origin}${previewPrefix}form`, {
          method: "POST",
          body: "x",
          referrer,
        }),
      );
      assertEquals(res.status, 403, referrer);
    }
    assertEquals(
      (await f.routes.respond(
        browserRequest(`${origin}${previewPrefix}x`, {
          referrer: "https://evil.test/",
        }),
      )).status,
      204,
    );
    assertEquals(f.received.length, 1);
  } finally {
    f.close();
  }
});

Deno.test("a stripped referrer cannot POST", async () => {
  const f = makeRoutes();
  try {
    await f.register();
    const res = await f.routes.respond(
      browserRequest(`${origin}${previewPrefix}form`, {
        method: "POST",
        body: "x",
        referrerPolicy: "no-referrer",
      }),
    );
    assertEquals(res.status, 403);
    assertEquals(f.received.length, 0);
  } finally {
    f.close();
  }
});

Deno.test("body over 16 MiB is 413 before forwarding", async () => {
  const f = makeRoutes();
  try {
    await f.register();
    const res = await f.routes.respond(
      browserRequest(`${origin}${previewPrefix}form`, {
        method: "POST",
        body: new Uint8Array(16 * 1024 * 1024 + 1),
        referrer: `${origin}${previewPrefix}`,
      }),
    );
    assertEquals(res.status, 413);
    assertEquals(f.received.length, 0);
  } finally {
    f.close();
  }
});

Deno.test("top-level document navigation has an explanatory 403 page", async () => {
  const f = makeRoutes();
  try {
    await f.register();
    const res = await f.routes.respond(documentRequest());
    assertEquals(res.status, 403);
    assertStringIncludes(await res.text(), "preview panel");
    assertEquals(f.received.length, 0);
  } finally {
    f.close();
  }
});

Deno.test("guest response drops are logged once per session and name", async () => {
  const f = makeRoutes({
    replyHeaders: [
      ["refresh", "1"],
      ["date", "ignored"],
    ],
  });
  try {
    await f.register();
    await f.routes.respond(get());
    await f.routes.respond(get());
    assertEquals(f.logged.filter((m) => m.includes("refresh")).length, 1);
    assertEquals(f.logged.some((m) => m.includes("date")), false);
  } finally {
    f.close();
  }
});

Deno.test("invalid mapped referrer is omitted without losing the request", async () => {
  const f = makeRoutes();
  try {
    await f.register();
    const res = await f.routes.respond(
      browserRequest(`${origin}${previewPrefix}form`, {
        method: "POST",
        body: "x",
        referrer: `${origin}${previewPrefix}page%2fpart`,
      }),
    );
    assertEquals(res.status, 204);
    assertEquals(f.received[0].referrer, undefined);
    assertEquals(parseGuestRequest(f.received[0])?.app, "preview");
  } finally {
    f.close();
  }
});

Deno.test("the SW deadline covers queue wait and execution, then expires", async () => {
  const slowOk = makeRoutes({ requestTimeoutMs: 300, ownerDelayMs: 200 });
  try {
    await slowOk.register();
    assertEquals((await slowOk.routes.respond(get())).status, 204);
  } finally {
    slowOk.close();
  }
  const tooSlow = makeRoutes({ requestTimeoutMs: 300, ownerDelayMs: 600 });
  try {
    await tooSlow.register();
    assertEquals((await tooSlow.routes.respond(get())).status, 504);
  } finally {
    tooSlow.close();
  }
  assertEquals(DEFAULT_REQUEST_TIMEOUT_MS, REQUEST_DEADLINE_MS);
});
