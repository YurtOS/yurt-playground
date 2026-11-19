import { assert, assertEquals } from "@std/assert";
import { isHostname, isPublicAddress } from "../relay/policy.ts";
import { issueToken, verifyToken } from "../relay/token.ts";
import {
  createRelay,
  type Limits,
  type RelayConnection,
  type RelayWebSocket,
} from "../relay/relay.ts";

const ORIGIN = "https://playground.example";
const SECRET = "test secret";

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

Deno.test("relay token: genuine and unexpired only", async () => {
  const { token, expires } = await issueToken(SECRET, 1000, 60_000);
  assertEquals(expires, 61_000);
  const id = await verifyToken(SECRET, token, 2000);
  assert(id !== undefined);
  assertEquals(await verifyToken(SECRET, token, 61_000), undefined);
  assertEquals(await verifyToken("other secret", token, 2000), undefined);
  const [tokenId, , mac] = token.split(".");
  // A later expiry under the same MAC is refused.
  assertEquals(
    await verifyToken(SECRET, `${tokenId}.99999999.${mac}`, 2000),
    undefined,
  );
  assertEquals(await verifyToken(SECRET, "garbage", 2000), undefined);
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
  } = {},
) {
  const sockets: FakeSocket[] = [];
  const connects: string[] = [];
  const relay = createRelay({
    secret: SECRET,
    allowedOrigins: [ORIGIN],
    limits: options.limits,
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
  const get = (path: string, headers: Record<string, string> = {}) =>
    relay.handle(
      new Request(`https://relay.example${path}`, {
        headers: { Origin: ORIGIN, ...headers },
      }),
    );
  const token = async () => (await (await get("/token")).json()).token;
  const tcp = async (host: string, port: number, t?: string) => {
    await get(
      `/tcp?host=${host}&port=${port}&token=${
        encodeURIComponent(t ?? await token())
      }`,
      { Upgrade: "websocket" },
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
  );
  assertEquals(other.status, 403);
  const none = await relay.handle(new Request("https://relay.example/token"));
  assertEquals(none.status, 403);
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
  assertEquals([...relay.usage.values()], [{ open: 1, bytes: 6 }]);
  // The peer ends: the WebSocket closes normally and the slot is free.
  peer.end();
  await tick();
  await tick();
  assertEquals(socket.closed?.code, 1000);
  assertEquals([...relay.usage.values()][0].open, 0);
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
