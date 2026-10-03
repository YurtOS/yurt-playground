// deno-lint-ignore-file require-await
import { assertEquals, assertRejects } from "@std/assert";
import { DatasetteRoutes } from "../src/datasette_routes.ts";
const session = "11111111-1111-4111-8111-111111111111",
  prefix = `/apps/datasette/${session}/`;
const hashes = ["sha256-" + "A".repeat(43) + "="];
const client = {
  id: "owner",
  url: "http://playground/",
  postMessage: () => {},
};
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
Deno.test("Datasette routes reject a foreign owner claiming an existing session", async () => {
  const f = fixture();
  const extra = new MessageChannel();
  try {
    await f.routes.register(client, {
      type: "datasette-register",
      session,
      prefix,
      nonce: "n",
      hashes,
    }, f.channel.port1);
    await assertRejects(() =>
      f.routes.register({ ...client, id: "other" }, {
        type: "datasette-register",
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
Deno.test("Datasette routes reject POST before contacting the owner and omit HEAD errors", async () => {
  const f = fixture();
  try {
    assertEquals(
      (await f.routes.respond(
        new Request("http://playground" + prefix, {
          method: "POST",
          body: "write",
        }),
      )).status,
      405,
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
