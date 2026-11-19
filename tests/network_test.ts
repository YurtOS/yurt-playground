import { assert, assertEquals } from "@std/assert";
import {
  ACK_EVERY,
  answerDns,
  DNS_CACHE_NAMES,
  dnsAnswer,
  INBOX_CAP,
  MAX_CONNECTIONS,
  type NetworkStatus,
  parseDnsQuery,
  RelayClient,
  RelayTcp,
} from "../src/network.ts";
import {
  CONFIGURED_RELAY,
  relayOf,
  relaySources,
} from "../src/network_config.ts";
import { networkWanted } from "../src/network_toggle.ts";
import { contentSecurityPolicy, cspSources, withRelay } from "../src/csp.ts";

/** A DNS query for `name` of `type`, as musl sends one. */
function query(name: string, type: number, id = 0x1234): Uint8Array {
  const labels = name.split(".").flatMap((label) => [
    label.length,
    ...new TextEncoder().encode(label),
  ]);
  return new Uint8Array([
    id >> 8,
    id & 0xff,
    0x01,
    0x00, // RD
    0,
    1, // one question
    0,
    0,
    0,
    0,
    0,
    0,
    ...labels,
    0,
    type >> 8,
    type & 0xff,
    0,
    1,
  ]);
}

const rcode = (reply: Uint8Array) => reply[3] & 0x0f;
const answers = (reply: Uint8Array) => (reply[6] << 8) | reply[7];

Deno.test("dns: a question is parsed and answered with A records", () => {
  const q = query("PyPI.org", 1);
  const question = parseDnsQuery(q)!;
  assertEquals(question.name, "pypi.org");
  assertEquals(question.type, 1);
  assertEquals(question.id, 0x1234);
  const reply = dnsAnswer(q, question, ["151.101.0.223", "151.101.64.223"]);
  // Same id, QR + RD + RA, one question, two answers.
  assertEquals([...reply.subarray(0, 8)], [
    0x12,
    0x34,
    0x81,
    0x80,
    0,
    1,
    0,
    2,
  ]);
  const first = q.byteLength;
  assertEquals([...reply.subarray(first, first + 16)], [
    0xc0,
    0x0c, // the question's name
    0,
    1, // A
    0,
    1, // IN
    0,
    0,
    0,
    60, // TTL
    0,
    4,
    151,
    101,
    0,
    223,
  ]);
});

Deno.test("dns: what is not a single standard question is dropped", () => {
  assertEquals(parseDnsQuery(new Uint8Array(5)), undefined);
  const response = query("pypi.org", 1);
  response[2] |= 0x80; // a response, not a query
  assertEquals(parseDnsQuery(response), undefined);
  const cut = query("pypi.org", 1).subarray(0, 20);
  assertEquals(parseDnsQuery(cut), undefined);
});

Deno.test("dns: off refuses, and only A questions reach the relay", async () => {
  const asked: string[] = [];
  const resolve = (name: string) => {
    asked.push(name);
    return Promise.resolve(name === "pypi.org" ? ["151.101.0.223"] : []);
  };
  const off = await answerDns(query("pypi.org", 1), false, resolve);
  assertEquals(rcode(off!), 5); // REFUSED
  const a = await answerDns(query("pypi.org", 1), true, resolve);
  assertEquals([rcode(a!), answers(a!)], [0, 1]);
  const aaaa = await answerDns(query("pypi.org", 28), true, resolve);
  assertEquals([rcode(aaaa!), answers(aaaa!)], [0, 0]);
  const mx = await answerDns(query("pypi.org", 15), true, resolve);
  assertEquals(rcode(mx!), 4); // NOTIMP
  const single = await answerDns(query("intranet", 1), true, resolve);
  assertEquals(rcode(single!), 3); // NXDOMAIN, not asked
  const none = await answerDns(query("no.such.example", 1), true, resolve);
  assertEquals(rcode(none!), 3);
  const failing = await answerDns(
    query("pypi.org", 1),
    true,
    () => Promise.reject(new Error("relay down")),
  );
  assertEquals(rcode(failing!), 2); // SERVFAIL
  assertEquals(asked, ["pypi.org", "no.such.example"]);
});

/** A WebSocket a test drives: the relay's side of it. */
class FakeWebSocket {
  static made: FakeWebSocket[] = [];
  binaryType = "blob";
  bufferedAmount = 0;
  sent: (Uint8Array | string)[] = [];
  closed = false;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  constructor(readonly url: string) {
    FakeWebSocket.made.push(this);
  }
  send(data: Uint8Array | string) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
  }
  /** The relay says the TCP connection is up. */
  up() {
    this.onmessage?.({ data: "ok" });
  }
  bytes(...data: number[]) {
    this.onmessage?.({ data: new Uint8Array(data).buffer });
  }
  chunk(size: number) {
    this.onmessage?.({ data: new ArrayBuffer(size) });
  }
  end(code = 1000) {
    this.onclose?.({ code, reason: "" });
  }
}

function fakeRelay() {
  FakeWebSocket.made = [];
  const statuses: NetworkStatus[] = [];
  const client = new RelayClient(
    "https://relay.example",
    (input) => {
      const url = String(input);
      return Promise.resolve(
        url.endsWith("/token")
          ? Response.json({ token: "t0", expires: Date.now() + 3_600_000 })
          : new Response(null, { status: 500 }),
      );
    },
  );
  const tcp = new RelayTcp(
    client,
    (status) => statuses.push(status),
    (url) => new FakeWebSocket(url) as unknown as WebSocket,
  );
  return { tcp, statuses };
}

const settle = () => new Promise((r) => setTimeout(r, 0));
const KH_CONNECT_ASYNC = 1 << 30;

Deno.test("relay tcp: off until turned on", () => {
  const { tcp } = fakeRelay();
  assertEquals(tcp.enabled, false);
  assertEquals(tcp.connect("151.101.0.223", 443, KH_CONNECT_ASYNC), -101);
  assertEquals(FakeWebSocket.made, []);
});

Deno.test("relay tcp: ports other than 80, 443 and 9418 are refused", () => {
  const { tcp } = fakeRelay();
  tcp.setEnabled(true);
  for (const port of [22, 25, 53, 8080]) {
    assertEquals(tcp.connect("151.101.0.223", port, KH_CONNECT_ASYNC), -13);
  }
});

Deno.test("relay tcp: a connect, its handshake, and data both ways", async () => {
  const { tcp, statuses } = fakeRelay();
  tcp.setEnabled(true);
  const handle = tcp.connect("151.101.0.223", 443, KH_CONNECT_ASYNC);
  assert(handle > 0);
  assertEquals(tcp.connectStatus(handle), 0);
  let writable = false;
  tcp.watchReady(handle, "writable", () => writable = true);
  await settle();
  const ws = FakeWebSocket.made[0];
  assertEquals(
    ws.url,
    "wss://relay.example/tcp?host=151.101.0.223&port=443&token=t0",
  );
  assertEquals(tcp.send(handle, new Uint8Array([1])), -11);
  ws.up();
  assert(writable);
  assertEquals(tcp.connectStatus(handle), 1);
  assertEquals(tcp.send(handle, new Uint8Array([1, 2])), 2);
  assertEquals(ws.sent, [new Uint8Array([1, 2])]);

  const buf = new Uint8Array(2);
  assertEquals(tcp.recv(handle, buf, 0), -11);
  let readable = false;
  tcp.watchReady(handle, "readable", () => readable = true);
  ws.bytes(7, 8, 9);
  assert(readable);
  assertEquals(tcp.recv(handle, buf, 2 /* MSG_PEEK */), 2);
  assertEquals(tcp.recv(handle, buf, 0), 2);
  assertEquals([...buf], [7, 8]);
  assertEquals(tcp.recv(handle, buf, 0), 1);
  assertEquals(buf[0], 9);
  // The peer's EOF.
  ws.end();
  assertEquals(tcp.recv(handle, buf, 0), 0);
  assertEquals(statuses.at(-1), { enabled: true, open: 0 });
});

Deno.test("relay tcp: the relay's refusal is the connect's errno", async () => {
  const { tcp } = fakeRelay();
  tcp.setEnabled(true);
  const handle = tcp.connect("151.101.0.223", 443, KH_CONNECT_ASYNC);
  await settle();
  FakeWebSocket.made[0].end(4013);
  assertEquals(tcp.connectStatus(handle), -13);
  const other = tcp.connect("151.101.0.223", 443, KH_CONNECT_ASYNC);
  await settle();
  FakeWebSocket.made[1].end(1006); // no word from the relay
  assertEquals(tcp.connectStatus(other), -111);
});

Deno.test("relay tcp: cut and off reset every connection", async () => {
  const { tcp } = fakeRelay();
  tcp.setEnabled(true);
  const handle = tcp.connect("151.101.0.223", 443, KH_CONNECT_ASYNC);
  await settle();
  FakeWebSocket.made[0].up();
  assertEquals(tcp.status().open, 1);
  tcp.cutAll();
  assert(FakeWebSocket.made[0].closed);
  assertEquals(tcp.status().open, 0);
  const buf = new Uint8Array(4);
  assertEquals(tcp.recv(handle, buf, 0), -104); // ECONNRESET, once
  assertEquals(tcp.recv(handle, buf, 0), 0);

  const again = tcp.connect("151.101.0.223", 443, KH_CONNECT_ASYNC);
  await settle();
  FakeWebSocket.made[1].up();
  tcp.setEnabled(false);
  assert(FakeWebSocket.made[1].closed);
  assertEquals(tcp.recv(again, buf, 0), -104);
});

Deno.test("relay tcp: at most MAX_CONNECTIONS open", () => {
  const { tcp } = fakeRelay();
  tcp.setEnabled(true);
  for (let i = 0; i < MAX_CONNECTIONS; i++) {
    assert(tcp.connect("151.101.0.223", 443, KH_CONNECT_ASYNC) > 0);
  }
  assertEquals(tcp.connect("151.101.0.223", 443, KH_CONNECT_ASYNC), -11);
});

Deno.test("relay client: a token is reused until near its expiry", async () => {
  let now = 0;
  let issued = 0;
  const client = new RelayClient(
    "https://relay.example",
    (input) => {
      const url = String(input);
      if (url.endsWith("/token")) {
        issued++;
        return Promise.resolve(
          Response.json({ token: `t${issued}`, expires: now + 600_000 }),
        );
      }
      return Promise.resolve(Response.json({ addresses: ["151.101.0.223"] }));
    },
    () => now,
  );
  assertEquals(await client.token(), "t1");
  assertEquals(await client.token(), "t1");
  now = 140_000; // three quarters of its life still ahead
  assertEquals(await client.token(), "t1");
  now = 160_000; // a connection opened now would get less than that
  assertEquals(await client.token(), "t2");
  assertEquals(await client.resolve("pypi.org"), ["151.101.0.223"]);
});

Deno.test("network config: no relay configured, so no toggle and no policy", () => {
  // What merging this changes in production: nothing, until a relay is
  // deployed and named in config/network.json.
  assertEquals(CONFIGURED_RELAY, undefined);
  const policy = contentSecurityPolicy();
  assert(!/wss?:/.test(cspSources(policy, "connect-src").join(" ")));
  assertEquals(relayOf({ relay: null }), undefined);
  assertEquals(relayOf({}), undefined);
  assertEquals(
    relayOf({ relay: "https://relay.example/path" }),
    "https://relay.example",
  );
});

Deno.test("network config: a relay is admitted in connect-src outside JupyterLite", () => {
  const relay = "https://relay.example";
  assertEquals(relaySources(relay), [relay, "wss://relay.example"]);
  const page = cspSources(
    contentSecurityPolicy({ networkRelay: relay }),
    "connect-src",
  );
  assert(page.includes(relay) && page.includes("wss://relay.example"));
  const lite = cspSources(
    contentSecurityPolicy({ networkRelay: relay, sameOriginOnly: true }),
    "connect-src",
  );
  assert(!lite.includes(relay));
  const local = cspSources(
    withRelay(contentSecurityPolicy(), "http://127.0.0.1:9"),
    "connect-src",
  );
  assert(local.includes("ws://127.0.0.1:9"));
});

Deno.test("network toggle: on again only after the page's own reload", () => {
  const store = new Map<string, string>();
  const storage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, v),
    removeItem: (k: string) => store.delete(k),
  } as unknown as Storage;
  assertEquals(networkWanted(storage, false), false);
  assertEquals(networkWanted(storage, true), false);
  assertEquals(networkWanted(undefined, true), false);
  store.set("yurt-network-on", "1");
  // The page reloaded itself to resume its sandbox: on again.
  assertEquals(networkWanted(storage, true), true);
  // A refresh, or a tab the browser duplicated with this storage: off,
  // and the choice is forgotten.
  assertEquals(networkWanted(storage, false), false);
  assertEquals(store.has("yurt-network-on"), false);
  assertEquals(networkWanted(storage, true), false);
  const throwing = {
    getItem: () => {
      throw new Error("blocked");
    },
  } as unknown as Storage;
  assertEquals(networkWanted(throwing, true), false);
});

Deno.test("relay tcp: the guest's reads are credited to the relay, and too much is cut", async () => {
  const { tcp } = fakeRelay();
  tcp.setEnabled(true);
  const handle = tcp.connect("151.101.0.223", 443, KH_CONNECT_ASYNC);
  await settle();
  const ws = FakeWebSocket.made[0];
  ws.up();
  ws.chunk(ACK_EVERY + 10);
  const small = new Uint8Array(ACK_EVERY - 1);
  assertEquals(tcp.recv(handle, small, 2 /* MSG_PEEK */), ACK_EVERY - 1);
  assertEquals(tcp.recv(handle, small, 0), ACK_EVERY - 1);
  // A peek is no read, and less than ACK_EVERY waits for more.
  assertEquals(ws.sent, []);
  assertEquals(tcp.recv(handle, new Uint8Array(5), 0), 5);
  assertEquals(ws.sent, [`ack ${ACK_EVERY + 4}`]);
  // A relay that keeps sending past the cap is cut.
  ws.chunk(INBOX_CAP);
  assert(ws.closed);
  assertEquals(tcp.recv(handle, new Uint8Array(6), 0), 6);
  assertEquals(
    tcp.recv(handle, new Uint8Array(INBOX_CAP), 0),
    INBOX_CAP,
  );
  assertEquals(tcp.recv(handle, new Uint8Array(1), 0), -104);
});

Deno.test("relay client: the name cache stays bounded", async () => {
  const client = new RelayClient(
    "https://relay.example",
    (input) =>
      Promise.resolve(
        String(input).endsWith("/token")
          ? Response.json({ token: "t", expires: Date.now() + 3_600_000 })
          : Response.json({ addresses: ["151.101.0.223"] }),
      ),
  );
  for (let i = 0; i < DNS_CACHE_NAMES + 10; i++) {
    await client.resolve(`host${i}.example`);
  }
  assertEquals(client.cachedNames, DNS_CACHE_NAMES);
});
