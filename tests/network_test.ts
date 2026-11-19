import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  answerDns,
  DNS_CACHE_NAMES,
  dnsAnswer,
  INBOX_CAP,
  MAX_CONNECTIONS,
  type NetworkStatus,
  parseDnsQuery,
  RelayClient,
  RelayTcp,
  RESOLV_CONF,
  TabNetwork,
  TOKEN_DEADLINE_MS,
} from "../src/network.ts";
import {
  CONFIGURED_RELAY,
  networkOf,
  relaySources,
  TURNSTILE_ORIGIN,
} from "../src/network_config.ts";
import {
  answerTokenRequest,
  networkWanted,
  settleWithin,
  shareInFlight,
} from "../src/network_toggle.ts";
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
    () => Promise.resolve({ token: "t0", ttl: 3600 }),
    () => Promise.resolve(new Response(null, { status: 500 })),
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

Deno.test("relay client: a token is reused for a quarter of its life, by the page's own clock", async () => {
  // The page's clock is far off the relay's: only the fetch time (here)
  // and the relay's ttl count.
  let now = 9_000_000_000;
  let issued = 0;
  const client = new RelayClient(
    "https://relay.example",
    () => {
      issued++;
      return Promise.resolve({ token: `t${issued}`, ttl: 600 });
    },
    () => Promise.resolve(Response.json({ addresses: ["151.101.0.223"] })),
    () => now,
  );
  assertEquals(await client.token(), "t1");
  assertEquals(await client.token(), "t1");
  now += 140_000; // three quarters of its life still ahead
  assertEquals(await client.token(), "t1");
  now += 20_000; // a connection opened now would get less than that
  assertEquals(await client.token(), "t2");
  assertEquals(await client.resolve("pypi.org"), ["151.101.0.223"]);
});

Deno.test("network config: the deployed relay, and Turnstile, are admitted", () => {
  assertEquals(CONFIGURED_RELAY, "https://yurt-relay.ofersa.workers.dev");
  const policy = contentSecurityPolicy();
  assert(
    cspSources(policy, "connect-src").includes(
      "wss://yurt-relay.ofersa.workers.dev",
    ),
  );
  assertEquals(cspSources(policy, "frame-src"), [TURNSTILE_ORIGIN]);
  // The JupyterLite pages too (#384), though without the models.
  const lite = contentSecurityPolicy({ sameOriginOnly: true });
  assert(
    cspSources(lite, "connect-src").includes(
      "wss://yurt-relay.ofersa.workers.dev",
    ),
  );
  assertEquals(cspSources(lite, "frame-src"), [TURNSTILE_ORIGIN]);
  assert(!cspSources(lite, "connect-src").includes("https://openrouter.ai"));
});

Deno.test("network config: with no relay, no toggle and no policy", () => {
  // A build whose config names no relay changes nothing.
  const policy = contentSecurityPolicy({ networkRelay: null });
  assert(!/wss?:/.test(cspSources(policy, "connect-src").join(" ")));
  assert(!cspSources(policy, "script-src").includes(TURNSTILE_ORIGIN));
  assertEquals(cspSources(policy, "frame-src"), ["'none'"]);
  assertEquals(networkOf({ relay: null, turnstileSiteKey: null }), undefined);
  assertEquals(networkOf({}), undefined);
  assertEquals(
    networkOf({
      relay: "https://relay.example/path",
      turnstileSiteKey: "0xKEY",
    }),
    { relay: "https://relay.example", siteKey: "0xKEY" },
  );
  // A relay without its Turnstile site key is a broken build, not a quiet
  // one.
  assertThrows(() =>
    networkOf({ relay: "https://relay.example", turnstileSiteKey: null })
  );
});

Deno.test("network config: a relay is admitted in connect-src, JupyterLite's too", () => {
  const relay = "https://relay.example";
  assertEquals(relaySources(relay), [relay, "wss://relay.example"]);
  const page = cspSources(
    contentSecurityPolicy({ networkRelay: relay }),
    "connect-src",
  );
  assert(page.includes(relay) && page.includes("wss://relay.example"));
  // Turnstile's script and challenge frame come with a relay.
  const policy = contentSecurityPolicy({ networkRelay: relay });
  assert(cspSources(policy, "script-src").includes(TURNSTILE_ORIGIN));
  assertEquals(cspSources(policy, "frame-src"), [TURNSTILE_ORIGIN]);
  const lite = cspSources(
    contentSecurityPolicy({ networkRelay: relay, sameOriginOnly: true }),
    "connect-src",
  );
  assert(lite.includes(relay) && lite.includes("wss://relay.example"));
  const local = cspSources(
    withRelay(contentSecurityPolicy(), "http://127.0.0.1:9"),
    "connect-src",
  );
  assert(local.includes("ws://127.0.0.1:9"));
  const localPolicy = withRelay(contentSecurityPolicy(), "http://127.0.0.1:9");
  assertEquals(cspSources(localPolicy, "frame-src"), [TURNSTILE_ORIGIN]);
  assert(cspSources(localPolicy, "script-src").includes(TURNSTILE_ORIGIN));
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

Deno.test("relay tcp: each seq is acknowledged once the guest has read past it", async () => {
  const { tcp } = fakeRelay();
  tcp.setEnabled(true);
  const handle = tcp.connect("151.101.0.223", 443, KH_CONNECT_ASYNC);
  await settle();
  const ws = FakeWebSocket.made[0];
  ws.up();
  ws.chunk(10);
  ws.onmessage?.({ data: "seq first" });
  ws.chunk(10);
  ws.onmessage?.({ data: "seq second" });
  const buf = new Uint8Array(6);
  assertEquals(tcp.recv(handle, buf, 2 /* MSG_PEEK */), 6);
  assertEquals(tcp.recv(handle, buf, 0), 6);
  // A peek is no read, and 6 of the 10 bytes before `first` is not all.
  assertEquals(ws.sent, []);
  assertEquals(tcp.recv(handle, new Uint8Array(4), 0), 4);
  assertEquals(ws.sent, ["ack first"]);
  assertEquals(tcp.recv(handle, new Uint8Array(10), 0), 10);
  assertEquals(ws.sent, ["ack first", "ack second"]);
  // A seq for bytes already read is answered at once.
  ws.onmessage?.({ data: "seq third" });
  assertEquals(ws.sent.at(-1), "ack third");
});

Deno.test("relay tcp: a relay that sends past the cap is cut", async () => {
  const { tcp } = fakeRelay();
  tcp.setEnabled(true);
  const handle = tcp.connect("151.101.0.223", 443, KH_CONNECT_ASYNC);
  await settle();
  const ws = FakeWebSocket.made[0];
  ws.up();
  ws.chunk(INBOX_CAP);
  assert(!ws.closed);
  ws.chunk(1);
  assert(ws.closed);
  assertEquals(
    tcp.recv(handle, new Uint8Array(INBOX_CAP), 0),
    INBOX_CAP,
  );
  assertEquals(tcp.recv(handle, new Uint8Array(1), 0), 1);
  assertEquals(tcp.recv(handle, new Uint8Array(1), 0), -104);
});

Deno.test("relay client: the name cache stays bounded", async () => {
  const client = new RelayClient(
    "https://relay.example",
    () => Promise.resolve({ token: "t", ttl: 3600 }),
    () => Promise.resolve(Response.json({ addresses: ["151.101.0.223"] })),
  );
  for (let i = 0; i < DNS_CACHE_NAMES + 10; i++) {
    await client.resolve(`host${i}.example`);
  }
  assertEquals(client.cachedNames, DNS_CACHE_NAMES);
});

Deno.test("relay client: a token that does not come in time fails the connect", async () => {
  let asked = 0;
  const client = new RelayClient(
    "https://relay.example",
    () => {
      asked++;
      // The page does not answer; the coordinator gives up on it later.
      return new Promise((_, reject) =>
        setTimeout(() => reject(new Error("no answer")), 60)
      );
    },
    () => Promise.resolve(new Response(null, { status: 500 })),
    Date.now,
    20,
  );
  const tcp = new RelayTcp(
    client,
    () => {},
    (url) => new FakeWebSocket(url) as unknown as WebSocket,
  );
  FakeWebSocket.made = [];
  tcp.setEnabled(true);
  const handle = tcp.connect("151.101.0.223", 443, KH_CONNECT_ASYNC);
  assertEquals(tcp.connectStatus(handle), 0);
  await new Promise((r) => setTimeout(r, 50));
  assertEquals(tcp.connectStatus(handle), -101); // ENETUNREACH
  assertEquals(FakeWebSocket.made, []);
  // Once that request has failed, the next connect asks again.
  await new Promise((r) => setTimeout(r, 30));
  tcp.connect("151.101.0.223", 443, KH_CONNECT_ASYNC);
  await new Promise((r) => setTimeout(r, 100));
  assertEquals(asked, 2);
});

Deno.test("relay client: connects waiting together share one token fetch", async () => {
  let asked = 0;
  let answer: (t: { token: string; ttl: number }) => void = () => {};
  const client = new RelayClient(
    "https://relay.example",
    () => {
      asked++;
      return new Promise((resolve) => answer = resolve);
    },
  );
  const first = client.token();
  const second = client.token();
  answer({ token: "t", ttl: 600 });
  assertEquals([await first, await second, asked], ["t", "t", 1]);
});

Deno.test("relay client: a token that lands after the deadline is kept for the next connect", async () => {
  let asked = 0;
  let answer: (t: { token: string; ttl: number }) => void = () => {};
  const client = new RelayClient(
    "https://relay.example",
    () => {
      asked++;
      return new Promise((resolve) => answer = resolve);
    },
    () => Promise.resolve(new Response(null, { status: 500 })),
    Date.now,
    20,
  );
  await assertRejects(() => client.token(), Error, "in time");
  // A second connect during the same check waits for it, too.
  const waiting = client.token();
  answer({ token: "late", ttl: 600 });
  assertEquals(await waiting, "late");
  assertEquals(await client.token(), "late");
  assertEquals(asked, 1);
});

Deno.test("page: a token request waits at most its deadline, and cleans up either way", async () => {
  let cleaned = 0;
  const hanging = settleWithin<string>(() => () => cleaned++, 20);
  await assertRejects(() => hanging, Error, "no answer");
  assertEquals(cleaned, 1);
  const answered = await settleWithin<string>((resolve) => {
    queueMicrotask(() => resolve("ok"));
    return () => cleaned++;
  }, 1000);
  assertEquals([answered, cleaned], ["ok", 2]);
});

Deno.test("page: a check in flight is shared, and the next one starts fresh", async () => {
  let started = 0;
  let finish: (v: number) => void = () => {};
  const once = shareInFlight(() => {
    started++;
    return new Promise<number>((resolve) => finish = resolve);
  });
  const a = once();
  const b = once();
  finish(7);
  assertEquals([await a, await b, started], [7, 7, 1]);
  const c = once();
  finish(8);
  assertEquals([await c, started], [8, 2]);
});

Deno.test("dns: a resolver's resends share one relay question", async () => {
  let asked = 0;
  let answer: (r: Response) => void = () => {};
  const client = new RelayClient(
    "https://relay.example",
    () => Promise.resolve({ token: "t", ttl: 600 }),
    () => {
      asked++;
      return new Promise((resolve) => answer = resolve);
    },
  );
  const first = client.resolve("pypi.org");
  const resend = client.resolve("PyPI.org");
  await new Promise((r) => setTimeout(r, 0));
  answer(Response.json({ addresses: ["151.101.0.223"] }));
  assertEquals([await first, await resend, asked], [
    ["151.101.0.223"],
    ["151.101.0.223"],
    1,
  ]);
});

Deno.test("dns: musl waits long enough for the first token", () => {
  // musl waits `timeout` seconds in all (its default 5 s was shorter than
  // a first Turnstile check, #383); it must cover the token deadline.
  const timeout = Number(/options timeout:(\d+)/.exec(RESOLV_CONF)?.[1]);
  assert(timeout * 1000 >= TOKEN_DEADLINE_MS, RESOLV_CONF);
  assert(RESOLV_CONF.startsWith("nameserver 127.0.0.1\n"));
});

Deno.test("network: turning it on starts the first token's check at once", async () => {
  let asked = 0;
  const network = new TabNetwork(
    "https://relay.example",
    () => {
      asked++;
      return Promise.resolve({ token: "t", ttl: 600 });
    },
    () => {},
  );
  network.setEnabled(true);
  await new Promise((r) => setTimeout(r, 0));
  assertEquals(asked, 1);
  // A connect after it takes that token.
  assertEquals(await network.relay.token(), "t");
  assertEquals(asked, 1);
  network.setEnabled(false);
});

Deno.test("page: a token request without a relay is answered with why", async () => {
  const posted: unknown[] = [];
  answerTokenRequest(
    { postMessage: (m) => posted.push(m) },
    Promise.resolve(undefined),
    () => {
      throw new Error("no widget without a relay");
    },
    7,
  );
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  assertEquals(posted, [{
    type: "network-token-reply",
    req: 7,
    error: "Error: no relay",
  }]);
});
