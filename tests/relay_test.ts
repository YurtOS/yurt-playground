import { assert, assertEquals, assertThrows } from "@std/assert";
import { clientKey, isHostname, isPublicAddress } from "../relay/policy.ts";
import { issueToken, verifyToken } from "../relay/token.ts";
import {
  configProblem,
  createRelay,
  type Limits,
  type RelayConnection,
  type RelayWebSocket,
  workerConfigProblem,
} from "../relay/relay.ts";

const ORIGIN = "https://playground.example";
const SECRET = "a test secret of thirty-two chars";
const CLIENT = "198.51.100.7";

Deno.test("relay policy: public unicast only, as the runtime's egress guard", () => {
  for (
    const ip of [
      "151.101.0.223",
      "140.82.112.3",
      "8.8.8.8",
      "2a04:4e42::223",
      "::ffff:151.101.0.223",
    ]
  ) {
    assert(isPublicAddress(ip), ip);
  }
  for (
    const ip of [
      "0.0.0.0",
      "10.1.2.3",
      "127.0.0.1",
      "100.64.0.1",
      "169.254.169.254",
      "172.16.0.1",
      "192.0.0.8",
      "192.0.2.1",
      "192.88.99.1",
      "192.168.1.1",
      "198.18.0.1",
      "198.51.100.1",
      "192.31.196.1",
      "192.52.193.1",
      "192.175.48.1",
      "203.0.113.1",
      "224.0.0.1",
      "240.0.0.1",
      "255.255.255.255",
      "::1",
      "::",
      "fe80::1",
      "fc00::1",
      "ff02::1",
      "2001:db8::1",
      "::ffff:10.0.0.1",
      "::ffff:127.0.0.1",
      "2002:0a00:0001::1", // 6to4 of 10.0.0.1
      "2001:0:0:0:0:0:f5ff:fffe", // Teredo of 10.0.0.1
      "010.0.0.1", // not canonical
      "pypi.org",
      "",
    ]
  ) {
    assert(!isPublicAddress(ip), ip);
  }
  assert(isHostname("pypi.org"));
  assert(isHostname("files.pythonhosted.org."));
  assert(!isHostname("localhost"));
  assert(!isHostname("a..b"));
  assert(!isHostname("-x.org"));
  assert(!isHostname("x".repeat(64) + ".org"));
});

Deno.test("relay token: genuine, unexpired and from its own client only", async () => {
  const { token, expires } = await issueToken(SECRET, CLIENT, 1000, 60_000);
  assertEquals(expires, 61_000);
  const verified = await verifyToken(SECRET, token, CLIENT, 2000);
  assertEquals(verified?.expires, 61_000);
  assertEquals(await verifyToken(SECRET, token, CLIENT, 61_000), undefined);
  assertEquals(
    await verifyToken(
      "another secret of thirty-two chars",
      token,
      CLIENT,
      2000,
    ),
    undefined,
  );
  // Handed to someone else, it is worthless.
  assertEquals(
    await verifyToken(SECRET, token, "192.0.2.99", 2000),
    undefined,
  );
  const [tokenId, , mac] = token.split(".");
  // A later expiry under the same MAC is refused.
  assertEquals(
    await verifyToken(SECRET, `${tokenId}.99999999.${mac}`, CLIENT, 2000),
    undefined,
  );
  assertEquals(await verifyToken(SECRET, "garbage", CLIENT, 2000), undefined);
});

Deno.test("relay: refuses to start without a real secret and origins", () => {
  const platform = {
    allowedOrigins: [ORIGIN],
    resolve: () => Promise.resolve([]),
    connect: () => Promise.reject(new Error("no")),
    upgrade: () => {
      throw new Error("no");
    },
  };
  for (const secret of ["", "short"]) {
    assertThrows(
      () => createRelay({ ...platform, secret }),
      Error,
      "RELAY_SECRET",
    );
  }
  for (
    const origins of [[], [""], ["https://site.test/path"], ["not a url"]]
  ) {
    assertThrows(
      () =>
        createRelay({ ...platform, secret: SECRET, allowedOrigins: origins }),
      Error,
      "RELAY_ORIGINS",
    );
  }
  assertEquals(configProblem(SECRET, [ORIGIN]), undefined);
});

/** A WebSocket the relay accepted, as a test sees it. */
class FakeSocket implements RelayWebSocket {
  sent: (string | Uint8Array)[] = [];
  closed: { code?: number; reason?: string } | undefined;
  #listeners = new Map<string, ((event: { data: unknown }) => void)[]>();
  send(data: string | Uint8Array) {
    this.sent.push(data);
  }
  close(code?: number, reason?: string) {
    this.closed ??= { code, reason };
  }
  addEventListener(type: string, listener: (event: { data: unknown }) => void) {
    this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), listener]);
  }
  emit(type: string, data?: unknown) {
    for (const listener of this.#listeners.get(type) ?? []) listener({ data });
  }
}

/** A TCP peer that echoes, and that a test can end. */
function echoConnection() {
  const written: Uint8Array[] = [];
  let push: (chunk: Uint8Array) => void = () => {};
  let end: () => void = () => {};
  let closed = false;
  const connection: RelayConnection = {
    readable: new ReadableStream({
      start(controller) {
        push = (chunk) => controller.enqueue(chunk);
        end = () => controller.close();
      },
    }),
    writable: new WritableStream({
      write(chunk) {
        written.push(chunk);
        push(chunk);
      },
    }),
    close: () => {
      closed = true;
    },
  };
  return {
    connection,
    written,
    end: () => end(),
    isClosed: () => closed,
  };
}

function testRelay(
  options: {
    limits?: Partial<Limits>;
    resolve?: (name: string) => Promise<string[]>;
    connect?: (ip: string, port: number) => Promise<RelayConnection>;
    now?: () => number;
  } = {},
) {
  const sockets: FakeSocket[] = [];
  const connects: string[] = [];
  const relay = createRelay({
    secret: SECRET,
    allowedOrigins: [ORIGIN],
    // Many tokens per test; the token limit has a test of its own.
    limits: { tokensPerMinute: 1000, ...options.limits },
    now: options.now,
    resolve: options.resolve ?? (() => Promise.resolve([])),
    connect: (ip, port) => {
      connects.push(`${ip}:${port}`);
      return options.connect?.(ip, port) ??
        Promise.resolve(echoConnection().connection);
    },
    upgrade: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return { socket, response: new Response(null, { status: 200 }) };
    },
  });
  const get = (
    path: string,
    headers: Record<string, string> = {},
    client: string | undefined = CLIENT,
  ) =>
    relay.handle(
      new Request(`https://relay.example${path}`, {
        headers: { Origin: ORIGIN, ...headers },
      }),
      client,
    );
  const token = async (client = CLIENT) =>
    (await (await get("/token", {}, client)).json()).token;
  const tcp = async (
    host: string,
    port: number,
    t?: string,
    client = CLIENT,
  ) => {
    await get(
      `/tcp?host=${host}&port=${port}&token=${
        encodeURIComponent(t ?? await token(client))
      }`,
      { Upgrade: "websocket" },
      client,
    );
    return sockets.at(-1)!;
  };
  return { relay, sockets, connects, get, token, tcp };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

Deno.test("relay: only an allowed origin gets anything", async () => {
  const { relay, get } = testRelay();
  const other = await relay.handle(
    new Request("https://relay.example/token", {
      headers: { Origin: "https://evil.example" },
    }),
    CLIENT,
  );
  assertEquals(other.status, 403);
  const none = await relay.handle(
    new Request("https://relay.example/token"),
    CLIENT,
  );
  assertEquals(none.status, 403);
  assertEquals((await get("/token", {}, "")).status, 400);
  const ok = await get("/token");
  assertEquals(ok.status, 200);
  assertEquals(ok.headers.get("Access-Control-Allow-Origin"), ORIGIN);
});

Deno.test("relay: /dns and /tcp need a valid token", async () => {
  const { get, sockets } = testRelay();
  assertEquals((await get("/dns?name=pypi.org")).status, 401);
  assertEquals((await get("/dns?name=pypi.org&token=x.1.y")).status, 401);
  const tcp = await get("/tcp?host=151.101.0.223&port=443&token=nope", {
    Upgrade: "websocket",
  });
  assertEquals(tcp.status, 401);
  assertEquals(sockets.length, 0);
});

Deno.test("relay: /dns answers public IPv4 addresses only", async () => {
  const { get, token } = testRelay({
    resolve: (name) =>
      Promise.resolve(
        name === "pypi.org"
          ? ["151.101.0.223", "10.0.0.1", "127.0.0.1", "2a04:4e42::223"]
          : [],
      ),
  });
  const t = encodeURIComponent(await token());
  const answer = await (await get(`/dns?name=PyPI.org&token=${t}`)).json();
  assertEquals(answer, { addresses: ["151.101.0.223"] });
  assertEquals((await get(`/dns?name=localhost&token=${t}`)).status, 400);
});

Deno.test("relay: /tcp refuses other ports and non-public addresses", async () => {
  const { tcp, connects } = testRelay();
  for (const port of [22, 25, 8080]) {
    const socket = await tcp("151.101.0.223", port);
    assertEquals(socket.closed?.code, 4013, `port ${port}`);
  }
  for (const host of ["10.0.0.1", "127.0.0.1", "169.254.169.254", "pypi.org"]) {
    const socket = await tcp(host, 443);
    assertEquals(socket.closed?.code, 4013, host);
  }
  assertEquals(connects, []);
});

Deno.test("relay: a connection is piped both ways after `ok`", async () => {
  const peer = echoConnection();
  const { tcp, relay } = testRelay({
    connect: () => Promise.resolve(peer.connection),
  });
  const socket = await tcp("151.101.0.223", 443);
  await tick();
  assertEquals(socket.sent, ["ok"]);
  socket.emit("message", new Uint8Array([1, 2, 3]).buffer);
  await tick();
  await tick();
  assertEquals(peer.written, [new Uint8Array([1, 2, 3])]);
  assertEquals(socket.sent.slice(1), [new Uint8Array([1, 2, 3])]);
  const [use] = relay.usage.tokens.values();
  assertEquals([use.open, use.bytes], [1, 6]);
  // The peer ends: the WebSocket closes normally and the slot is free.
  peer.end();
  await tick();
  await tick();
  assertEquals(socket.closed?.code, 1000);
  assertEquals([...relay.usage.tokens.values()][0].open, 0);
});

Deno.test("relay: a failed connect is a close with ECONNREFUSED", async () => {
  const { tcp } = testRelay({
    connect: () => Promise.reject(new Error("refused")),
  });
  const socket = await tcp("151.101.0.223", 443);
  await tick();
  assertEquals(socket.closed?.code, 4111);
  assertEquals(socket.sent, []);
});

Deno.test("relay: at most socketsPerToken connections per token", async () => {
  const { tcp, token } = testRelay({ limits: { socketsPerToken: 2 } });
  const t = await token();
  const a = await tcp("151.101.0.223", 443, t);
  const b = await tcp("151.101.0.223", 443, t);
  const c = await tcp("151.101.0.223", 443, t);
  assertEquals([a.closed, b.closed], [undefined, undefined]);
  assertEquals(c.closed?.code, 4011);
  // Another tab's token is counted on its own.
  const d = await tcp("151.101.0.223", 443, await token());
  assertEquals(d.closed, undefined);
  // A closed one frees its slot.
  a.emit("close");
  const e = await tcp("151.101.0.223", 443, t);
  assertEquals(e.closed, undefined);
  await tick();
  for (const open of [b, d, e]) open.emit("close");
});

Deno.test("relay: a token's bytes are capped", async () => {
  const peer = echoConnection();
  const { tcp, token } = testRelay({
    limits: { bytesPerToken: 4 },
    connect: () => Promise.resolve(peer.connection),
  });
  const t = await token();
  const socket = await tcp("151.101.0.223", 443, t);
  await tick();
  socket.emit("message", new Uint8Array(5).buffer);
  assertEquals(socket.closed?.code, 4104);
  assert(peer.isClosed());
  // And no new connection for that token.
  const next = await tcp("151.101.0.223", 443, t);
  assertEquals(next.closed?.code, 4013);
});

Deno.test("relay: an idle connection is closed", async () => {
  const peer = echoConnection();
  const { tcp } = testRelay({
    limits: { idleMs: 10 },
    connect: () => Promise.resolve(peer.connection),
  });
  const socket = await tcp("151.101.0.223", 443);
  await new Promise((r) => setTimeout(r, 50));
  assertEquals(socket.closed?.code, 4110);
  assert(peer.isClosed());
});

Deno.test("relay: a token works only from the address it was issued to", async () => {
  const { get, token, sockets } = testRelay({
    resolve: () => Promise.resolve(["151.101.0.223"]),
  });
  const t = encodeURIComponent(await token());
  assertEquals((await get(`/dns?name=pypi.org&token=${t}`)).status, 200);
  const elsewhere = await get(
    `/dns?name=pypi.org&token=${t}`,
    {},
    "192.0.2.99",
  );
  assertEquals(elsewhere.status, 401);
  const tcp = await get(
    `/tcp?host=151.101.0.223&port=443&token=${t}`,
    { Upgrade: "websocket" },
    "192.0.2.99",
  );
  assertEquals(tcp.status, 401);
  assertEquals(sockets.length, 0);
});

Deno.test("relay: /token is limited per address", async () => {
  const platformSaid: string[] = [];
  const relay = createRelay({
    secret: SECRET,
    allowedOrigins: [ORIGIN],
    limits: { tokensPerMinute: 2 },
    resolve: () => Promise.resolve([]),
    connect: () => Promise.reject(new Error("no")),
    upgrade: () => {
      throw new Error("no");
    },
    allowToken: (client) => {
      platformSaid.push(client);
      return Promise.resolve(client !== "192.0.2.66");
    },
  });
  const ask = (client: string) =>
    relay.handle(
      new Request("https://relay.example/token", {
        headers: { Origin: ORIGIN },
      }),
      client,
    ).then((r) => r.status);
  assertEquals([await ask(CLIENT), await ask(CLIENT), await ask(CLIENT)], [
    200,
    200,
    429,
  ]);
  // Another address has its own count; the platform's limit applies too.
  assertEquals(await ask("192.0.2.5"), 200);
  assertEquals(await ask("192.0.2.66"), 429);
  assertEquals(platformSaid, [CLIENT, CLIENT, "192.0.2.5", "192.0.2.66"]);
});

Deno.test("relay: a connection made after the page left is closed", async () => {
  const peer = echoConnection();
  let open: (c: RelayConnection) => void = () => {};
  const { tcp, relay } = testRelay({
    connect: () => new Promise((resolve) => open = resolve),
  });
  const socket = await tcp("151.101.0.223", 443);
  socket.emit("close");
  open(peer.connection);
  await tick();
  assert(peer.isClosed());
  assertEquals(socket.sent, []);
  assertEquals([...relay.usage.tokens.values()][0].open, 0);
});

Deno.test("relay: a connection made after its timeout is closed", async () => {
  const peer = echoConnection();
  let open: (c: RelayConnection) => void = () => {};
  const { tcp } = testRelay({
    limits: { connectMs: 5 },
    connect: () => new Promise((resolve) => open = resolve),
  });
  const socket = await tcp("151.101.0.223", 443);
  await new Promise((r) => setTimeout(r, 20));
  assertEquals(socket.closed?.code, 4110);
  open(peer.connection);
  await tick();
  assert(peer.isClosed());
});

Deno.test("relay: a page that outruns the server is cut", async () => {
  // A server that never takes a byte.
  const stuck: RelayConnection = {
    readable: new ReadableStream(),
    writable: new WritableStream({ write: () => new Promise(() => {}) }),
    close: () => {},
  };
  const { tcp } = testRelay({
    limits: { upstreamQueueBytes: 8 },
    connect: () => Promise.resolve(stuck),
  });
  const socket = await tcp("151.101.0.223", 443);
  await tick();
  socket.emit("message", new Uint8Array(6).buffer);
  assertEquals(socket.closed, undefined);
  socket.emit("message", new Uint8Array(6).buffer);
  assertEquals(socket.closed?.code, 4104);
});

Deno.test("relay: the server's bytes wait for the page's credit", async () => {
  const peer = echoConnection();
  const { tcp } = testRelay({
    limits: { downstreamWindow: 2 },
    connect: () => Promise.resolve(peer.connection),
  });
  const socket = await tcp("151.101.0.223", 443);
  await tick();
  for (const byte of [1, 2, 3, 4]) {
    socket.emit("message", new Uint8Array([byte]).buffer);
  }
  await new Promise((r) => setTimeout(r, 20));
  // Three bytes unacknowledged is past the window: reading stopped.
  assertEquals(socket.sent.slice(1).length, 3);
  socket.emit("message", "ack 2");
  await new Promise((r) => setTimeout(r, 20));
  assertEquals(
    socket.sent.slice(1),
    [1, 2, 3, 4].map((b) => new Uint8Array([b])),
  );
  // Credit for bytes never sent is a broken page.
  socket.emit("message", "ack 100");
  assertEquals(socket.closed?.code, 4104);
});

Deno.test("relay: a page that gives no credit is cut", async () => {
  const peer = echoConnection();
  const { tcp } = testRelay({
    limits: { downstreamWindow: 0, idleMs: 30 },
    connect: () => Promise.resolve(peer.connection),
  });
  const socket = await tcp("151.101.0.223", 443);
  await tick();
  socket.emit("message", new Uint8Array([1]).buffer);
  // The page keeps sending, so the connection is not idle; still no credit.
  const keepSending = setInterval(
    () => socket.emit("message", new Uint8Array([9]).buffer),
    5,
  );
  await new Promise((r) => setTimeout(r, 80));
  clearInterval(keepSending);
  assertEquals(socket.closed?.code, 4110);
  assert(peer.isClosed());
});

Deno.test("relay: connections end with their token, and usage is forgotten later", async () => {
  let clock = 1_000_000;
  const { tcp, relay, token } = testRelay({
    limits: { tokenTtlMs: 30 },
    now: () => clock,
  });
  const socket = await tcp("151.101.0.223", 443);
  await tick();
  assertEquals(socket.sent, ["ok"]);
  assertEquals(relay.usage.tokens.size, 1);
  await new Promise((r) => setTimeout(r, 60));
  assertEquals(socket.closed?.code, 4013);
  clock += 1000;
  // Not swept on every request...
  const next = await tcp("151.101.0.223", 443, await token());
  assertEquals(relay.usage.tokens.size, 2);
  next.emit("close");
  // ...but once the sweep interval has passed.
  clock += 30_000;
  const later = await tcp("151.101.0.223", 443, await token());
  assertEquals(relay.usage.tokens.size, 1);
  later.emit("close");
});

Deno.test("relay: callers are counted by IPv4 address or IPv6 /64", () => {
  assertEquals(clientKey("198.51.100.7"), "198.51.100.7");
  assertEquals(
    clientKey("2001:db8:aa:bb:1:2:3:4"),
    clientKey("2001:0db8:00aa:00bb:ffff::9"),
  );
  assert(clientKey("2001:db8:aa:bb::1") !== clientKey("2001:db8:aa:bc::1"));
});

Deno.test("relay: rotating IPv6 addresses in one /64 does not mint more tokens", async () => {
  const { get } = testRelay({ limits: { tokensPerMinute: 2 } });
  const statuses = [];
  for (let i = 1; i <= 3; i++) {
    statuses.push((await get("/token", {}, `2001:db8:1:2::${i}`)).status);
  }
  assertEquals(statuses, [200, 200, 429]);
  assertEquals((await get("/token", {}, "2001:db8:1:3::1")).status, 200);
});

Deno.test("relay: a token is still bound to its exact IPv6 address", async () => {
  const { get, token } = testRelay();
  const t = encodeURIComponent(await token("2001:db8:1:2::1"));
  const there = await get(
    `/dns?name=pypi.org&token=${t}`,
    {},
    "2001:db8:1:2::1",
  );
  assertEquals(there.status, 200);
  const sibling = await get(
    `/dns?name=pypi.org&token=${t}`,
    {},
    "2001:db8:1:2::2",
  );
  assertEquals(sibling.status, 401);
});

Deno.test("relay: connections and bytes are capped per caller across its tokens", async () => {
  const peer = echoConnection();
  let first = true;
  const { tcp, token } = testRelay({
    limits: { socketsPerToken: 16, socketsPerClient: 2, bytesPerClient: 4 },
    connect: () => {
      const c = first ? peer.connection : echoConnection().connection;
      first = false;
      return Promise.resolve(c);
    },
  });
  const a = await tcp("151.101.0.223", 443, await token());
  const b = await tcp("151.101.0.223", 443, await token());
  const c = await tcp("151.101.0.223", 443, await token());
  assertEquals([a.closed, b.closed, c.closed?.code], [
    undefined,
    undefined,
    4011,
  ]);
  // Another caller has its own count.
  const other = await tcp("151.101.0.223", 443, undefined, "192.0.2.5");
  assertEquals(other.closed, undefined);
  await tick();
  // Bytes across the caller's tokens.
  a.emit("message", new Uint8Array(3).buffer);
  b.emit("message", new Uint8Array(3).buffer);
  assertEquals(b.closed?.code, 4104);
  for (const s of [a, other]) s.emit("close");
});

Deno.test("relay: queued upstream bytes are capped per caller and in all", async () => {
  const stuck = (): RelayConnection => ({
    readable: new ReadableStream(),
    writable: new WritableStream({ write: () => new Promise(() => {}) }),
    close: () => {},
  });
  const { tcp, token } = testRelay({
    limits: {
      upstreamQueueBytes: 100,
      upstreamQueuePerClient: 10,
      upstreamQueueTotal: 16,
    },
    connect: () => Promise.resolve(stuck()),
  });
  const a = await tcp("151.101.0.223", 443, await token());
  const b = await tcp("151.101.0.223", 443, await token());
  const c = await tcp("151.101.0.223", 443, undefined, "192.0.2.5");
  await tick();
  a.emit("message", new Uint8Array(6).buffer);
  b.emit("message", new Uint8Array(6).buffer); // 12 > 10 for this caller
  assertEquals([a.closed, b.closed?.code], [undefined, 4104]);
  // The cut connection's bytes no longer count: 6 + 9 = 15 in all.
  c.emit("message", new Uint8Array(9).buffer);
  assertEquals(c.closed, undefined);
  c.emit("message", new Uint8Array(2).buffer); // 17 > 16 in all
  assertEquals(c.closed?.code, 4104);
  a.emit("close");
});

Deno.test("relay: /dns questions are limited per token", async () => {
  const { get, token } = testRelay({
    limits: { dnsPerMinute: 2 },
    resolve: () => Promise.resolve(["151.101.0.223"]),
  });
  const t = encodeURIComponent(await token());
  const ask = async () => (await get(`/dns?name=pypi.org&token=${t}`)).status;
  assertEquals([await ask(), await ask(), await ask()], [200, 200, 429]);
});

Deno.test("relay: the Worker refuses to serve without its rate limiting binding", () => {
  const limiter = { limit: () => Promise.resolve({ success: true }) };
  const env = { RELAY_SECRET: SECRET, RELAY_ORIGINS: `${ORIGIN}, ` };
  assertEquals(
    workerConfigProblem({ ...env, TOKEN_LIMITER: limiter }),
    undefined,
  );
  assert(workerConfigProblem(env)?.includes("TOKEN_LIMITER"));
  assert(
    workerConfigProblem({ ...env, RELAY_SECRET: "", TOKEN_LIMITER: limiter })
      ?.includes("RELAY_SECRET"),
  );
  assert(
    workerConfigProblem({ RELAY_SECRET: SECRET, TOKEN_LIMITER: limiter })
      ?.includes("RELAY_ORIGINS"),
  );
});
