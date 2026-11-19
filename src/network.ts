/**
 * The in-tab sandbox's network, through the Yurt relay (relay/relay.ts,
 * #380): off until the user turns it on, and absent altogether until a
 * relay is configured (src/network_config.ts).
 *
 * - {@link RelayTcp} is the kernel's outbound TCP backend: each guest
 *   connect is a WebSocket to the relay's `/tcp`, which opens the TCP
 *   connection itself. The kernel has already refused any destination that
 *   is not a public address; this refuses ports other than 80, 443 and
 *   9418, and the relay checks both again. Synchronous, like the kernel's
 *   calls into it: a connect returns at once and its handshake is reported
 *   through `connectStatus` and readiness, so nothing here needs JSPI.
 * - {@link startDnsServer} answers the guest's resolver on its own
 *   127.0.0.1:53 (UDP, musl's default nameserver) with what the relay's
 *   `/dns` resolves: public IPv4 addresses only. No other UDP leaves.
 */
import { METHOD } from "@yurt/kernel-host-interface-js";
import type { TcpSocketImpl } from "@yurt/kernel-host-interface-js";
import { backoff, fdRequest, type RelayKernel } from "./pkg_relay.ts";

export const ALLOWED_PORTS: ReadonlySet<number> = new Set([80, 443, 9418]);
/** Connections open at once, as the relay allows per tab. */
export const MAX_CONNECTIONS = 16;
/** Bytes queued on one WebSocket before a send waits. */
const SEND_HIGH_WATER = 1024 * 1024;
const WRITABLE_POLL_MS = 20;
/** The guest's reads are acknowledged to the relay (`ack <bytes>`) once
 * this many have accumulated: the relay sends at most its window (2 MiB)
 * ahead of them. */
export const ACK_EVERY = 256 * 1024;
/** Bytes received and not yet read, at most: a relay that does not keep to
 * its window is cut. */
export const INBOX_CAP = 16 * 1024 * 1024;
/** Names the page remembers at most. */
export const DNS_CACHE_NAMES = 256;
const CLOSE_ERRNO_BASE = 4000;
const DNS_TTL_S = 60;

const EAGAIN = 11;
const EBADF = 9;
const EACCES = 13;
const EPIPE = 32;
const EOPNOTSUPP = 95;
const ENETUNREACH = 101;
const ECONNRESET = 104;
const ECONNREFUSED = 111;
const MSG_PEEK = 2;

/** The relay as the page uses it: tokens, names, connection URLs. */
export class RelayClient {
  #token:
    | Promise<{ token: string; expires: number; fetched: number }>
    | undefined;
  #names = new Map<string, { addresses: string[]; until: number }>();

  constructor(
    readonly origin: string,
    private readonly fetchFn: typeof fetch = (input, init) =>
      fetch(input, init),
    private readonly now: () => number = Date.now,
  ) {}

  /** A token with three quarters of its life ahead at least: a connection
   * lives no longer than the token it was opened with. */
  async token(): Promise<string> {
    const held = await this.#token?.catch(() => undefined);
    if (
      held !== undefined &&
      held.expires - this.now() > (held.expires - held.fetched) * 3 / 4
    ) {
      return held.token;
    }
    this.#token = (async () => {
      const fetched = this.now();
      const response = await this.fetchFn(`${this.origin}/token`, {
        credentials: "omit",
      });
      if (!response.ok) throw new Error(`relay token: ${response.status}`);
      const { token, expires } = await response.json();
      return { token, expires, fetched };
    })();
    return (await this.#token).token;
  }

  /** `name`'s public IPv4 addresses, cached for {@link DNS_TTL_S}. */
  async resolve(name: string): Promise<string[]> {
    const key = name.toLowerCase();
    const cached = this.#names.get(key);
    if (cached !== undefined && cached.until > this.now()) {
      return cached.addresses;
    }
    const query = (token: string) =>
      this.fetchFn(
        `${this.origin}/dns?name=${encodeURIComponent(key)}&token=${
          encodeURIComponent(token)
        }`,
        { credentials: "omit" },
      );
    let response = await query(await this.token());
    if (response.status === 401) {
      // Expired under us: one more try with a fresh token.
      this.#token = undefined;
      response = await query(await this.token());
    }
    if (!response.ok) throw new Error(`relay dns: ${response.status}`);
    const { addresses } = await response.json() as { addresses: string[] };
    this.#remember(key, addresses);
    return addresses;
  }

  /** Keep `addresses` for `key`, within {@link DNS_CACHE_NAMES}: expired
   * names go first, then the oldest. */
  #remember(key: string, addresses: string[]): void {
    const now = this.now();
    this.#names.delete(key);
    if (this.#names.size >= DNS_CACHE_NAMES) {
      for (const [name, entry] of this.#names) {
        if (entry.until <= now) this.#names.delete(name);
      }
    }
    while (this.#names.size >= DNS_CACHE_NAMES) {
      this.#names.delete(this.#names.keys().next().value!);
    }
    this.#names.set(key, { addresses, until: now + DNS_TTL_S * 1000 });
  }

  /** How many names are remembered, for tests. */
  get cachedNames(): number {
    return this.#names.size;
  }

  /** The WebSocket URL of one connection to `host:port`. */
  tcpUrl(host: string, port: number, token: string): string {
    const url = new URL("/tcp", this.origin);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.search = new URLSearchParams({ host, port: String(port), token })
      .toString();
    return url.href;
  }
}

type Connection = {
  host: string;
  port: number;
  state: "connecting" | "open" | "closed";
  /** The relay said the TCP connection was up. */
  established: boolean;
  socket?: WebSocket;
  /** The negated errno of a failed handshake, or of a reset after it. */
  error?: number;
  inbox: Uint8Array[];
  /** Bytes in `inbox`. */
  buffered: number;
  /** Bytes the guest has read and the relay has not been told of. */
  unacked: number;
  readable: Set<() => void>;
  writable: Set<() => void>;
};

/** What the page shows: whether the network is on, and what is open. */
export type NetworkStatus = {
  enabled: boolean;
  open: number;
};

/** The kernel's outbound TCP backend over the relay; see the module doc. */
export class RelayTcp implements TcpSocketImpl {
  #enabled = false;
  #next = 1;
  #connections = new Map<number, Connection>();
  /** Handles of UDP sockets the kernel bound: they reach the guest's own
   * loopback only (the DNS server); nothing leaves. */
  #udp = new Set<number>();

  constructor(
    private readonly relay: RelayClient,
    /** Told whenever the status changes. */
    private readonly changed: (status: NetworkStatus) => void = () => {},
    private readonly makeSocket: (url: string) => WebSocket = (url) =>
      new WebSocket(url),
  ) {}

  get enabled(): boolean {
    return this.#enabled;
  }

  status(): NetworkStatus {
    let open = 0;
    for (const c of this.#connections.values()) {
      if (c.state !== "closed") open++;
    }
    return { enabled: this.#enabled, open };
  }

  /** Turn the network on or off; off also cuts every connection. */
  setEnabled(on: boolean): void {
    this.#enabled = on;
    if (!on) this.cutAll();
    this.changed(this.status());
  }

  /** Cut every open connection: the guest reads a reset. */
  cutAll(): void {
    for (const connection of this.#connections.values()) {
      this.#end(connection, -ECONNRESET);
    }
    this.changed(this.status());
  }

  #end(connection: Connection, error?: number): void {
    if (connection.state === "closed") return;
    if (error !== undefined) connection.error ??= error;
    connection.state = "closed";
    try {
      connection.socket?.close();
    } catch {
      // Already closed.
    }
    this.#wake(connection);
  }

  #wake(connection: Connection): void {
    for (const set of [connection.readable, connection.writable]) {
      const watchers = [...set];
      set.clear();
      for (const complete of watchers) complete();
    }
  }

  // The kernel names the local port it allocated (`localPort`); the relay
  // picks its own, which the guest never sees.
  connect(host: string, port: number, _flags: number): number {
    if (!this.#enabled) return -ENETUNREACH;
    if (!ALLOWED_PORTS.has(port)) return -EACCES;
    if (this.status().open >= MAX_CONNECTIONS) return -EAGAIN;
    const handle = this.#next++;
    const connection: Connection = {
      host,
      port,
      state: "connecting",
      established: false,
      inbox: [],
      buffered: 0,
      unacked: 0,
      readable: new Set(),
      writable: new Set(),
    };
    this.#connections.set(handle, connection);
    this.relay.token().then(
      (token) => {
        if (connection.state === "closed") return;
        this.#open(connection, this.relay.tcpUrl(host, port, token));
      },
      () => this.#end(connection, -ENETUNREACH),
    );
    this.changed(this.status());
    return handle;
  }

  #open(connection: Connection, url: string): void {
    let socket: WebSocket;
    try {
      socket = this.makeSocket(url);
    } catch {
      this.#end(connection, -ECONNREFUSED);
      return;
    }
    socket.binaryType = "arraybuffer";
    connection.socket = socket;
    socket.onmessage = (event) => {
      if (connection.state === "closed") return;
      if (typeof event.data === "string") {
        // The relay's word that the TCP connection is up.
        if (event.data === "ok" && connection.state === "connecting") {
          connection.state = "open";
          connection.established = true;
          this.#wake(connection);
          this.changed(this.status());
        }
        return;
      }
      const bytes = new Uint8Array(event.data as ArrayBuffer);
      connection.inbox.push(bytes);
      connection.buffered += bytes.byteLength;
      if (connection.buffered > INBOX_CAP) {
        this.#end(connection, -ECONNRESET);
        this.changed(this.status());
        return;
      }
      const watchers = [...connection.readable];
      connection.readable.clear();
      for (const complete of watchers) complete();
    };
    socket.onclose = (event) => {
      const errno = event.code >= CLOSE_ERRNO_BASE && event.code < 5000
        ? event.code - CLOSE_ERRNO_BASE
        : undefined;
      // A handshake that never came up was refused; an open connection the
      // relay ended normally is the peer's EOF.
      this.#end(
        connection,
        connection.state === "connecting"
          ? -(errno ?? ECONNREFUSED)
          : errno === undefined
          ? undefined
          : -ECONNRESET,
      );
      this.changed(this.status());
    };
  }

  connectStatus(handle: number): number {
    const connection = this.#connections.get(handle);
    if (connection === undefined) return -EBADF;
    if (connection.state === "connecting") return 0;
    if (!connection.established) return connection.error ?? -ECONNREFUSED;
    return 1;
  }

  send(handle: number, data: Uint8Array): number {
    const connection = this.#connections.get(handle);
    if (connection === undefined) return -EBADF;
    if (connection.state === "connecting") return -EAGAIN;
    if (connection.state === "closed") return connection.error ?? -EPIPE;
    const socket = connection.socket!;
    if (socket.bufferedAmount > SEND_HIGH_WATER) return -EAGAIN;
    socket.send(data.slice());
    return data.byteLength;
  }

  recv(handle: number, buf: Uint8Array, flags: number): number {
    const connection = this.#connections.get(handle);
    if (connection === undefined) return -EBADF;
    const next = connection.inbox[0];
    if (next !== undefined) {
      const n = Math.min(next.byteLength, buf.byteLength);
      buf.set(next.subarray(0, n));
      if ((flags & MSG_PEEK) === 0) {
        if (n === next.byteLength) connection.inbox.shift();
        else connection.inbox[0] = next.subarray(n);
        connection.buffered -= n;
        connection.unacked += n;
        if (connection.unacked >= ACK_EVERY && connection.state === "open") {
          connection.socket!.send(`ack ${connection.unacked}`);
          connection.unacked = 0;
        }
      }
      return n;
    }
    if (connection.state !== "closed") return -EAGAIN;
    if (connection.error !== undefined) {
      // Reported once, as Linux reports a reset; EOF after it.
      const error = connection.error;
      if ((flags & MSG_PEEK) === 0) connection.error = undefined;
      return error;
    }
    return 0;
  }

  writable(handle: number): number {
    const connection = this.#connections.get(handle);
    if (connection === undefined) return -EBADF;
    if (connection.state === "connecting") return 0;
    if (connection.state === "closed") return 1;
    return connection.socket!.bufferedAmount <= SEND_HIGH_WATER ? 1 : 0;
  }

  watchReady(
    handle: number,
    interest: "readable" | "writable" | "acceptable",
    complete: () => void,
  ): (() => void) | number {
    if (this.#udp.has(handle)) {
      // Nothing ever arrives from outside; sending is always possible.
      if (interest === "writable") queueMicrotask(complete);
      return () => {};
    }
    const connection = this.#connections.get(handle);
    if (connection === undefined) return -EBADF;
    if (interest === "acceptable") return -EOPNOTSUPP;
    const ready = interest === "readable"
      ? connection.inbox.length > 0 || connection.state === "closed"
      : this.writable(handle) === 1;
    if (ready) {
      queueMicrotask(complete);
      return () => {};
    }
    if (interest === "writable" && connection.state === "open") {
      // A WebSocket says nothing when its buffer drains: look again soon.
      const timer = setInterval(() => {
        if (this.writable(handle) !== 0) {
          clearInterval(timer);
          complete();
        }
      }, WRITABLE_POLL_MS);
      return () => clearInterval(timer);
    }
    const set = interest === "readable"
      ? connection.readable
      : connection.writable;
    set.add(complete);
    return () => set.delete(complete);
  }

  close(handle: number): number {
    if (this.#udp.delete(handle)) return 0;
    const connection = this.#connections.get(handle);
    if (connection === undefined) return 0;
    this.#end(connection);
    this.#connections.delete(handle);
    this.changed(this.status());
    return 0;
  }

  peerAddr(handle: number): { host: string; port: number } | null {
    const connection = this.#connections.get(handle);
    return connection === undefined
      ? null
      : { host: connection.host, port: connection.port };
  }

  localAddr(): { host: string; port: number } | null {
    return null;
  }

  // A guest's UDP socket bound to the wildcard (musl's resolver binds one)
  // needs a host handle; it only ever talks to the guest's own loopback.
  udpBind(): number {
    const handle = this.#next++;
    this.#udp.add(handle);
    return handle;
  }

  udpSendTo(): number {
    return -EACCES;
  }

  udpRecvFrom(): number {
    return -EAGAIN;
  }

  listen(): number {
    return -EOPNOTSUPP;
  }

  accept(): number {
    return -EOPNOTSUPP;
  }
}

// --- DNS on the guest's loopback -----------------------------------------

const DNS_PORT = 53;
const TYPE_A = 1;
const CLASS_IN = 1;
const RCODE_SERVFAIL = 2;
const RCODE_NXDOMAIN = 3;
const RCODE_NOTIMP = 4;
const RCODE_REFUSED = 5;

/** One DNS question: its name and type, and where it ends in the query. */
export type DnsQuestion = {
  id: number;
  name: string;
  type: number;
  end: number;
};

/** The single question of a standard query, or `undefined` when the
 * message is not one. */
export function parseDnsQuery(message: Uint8Array): DnsQuestion | undefined {
  if (message.byteLength < 12) return undefined;
  const view = new DataView(message.buffer, message.byteOffset);
  const flags = view.getUint16(2);
  // A query (QR 0), opcode QUERY, exactly one question.
  if ((flags & 0x8000) !== 0 || (flags & 0x7800) !== 0) return undefined;
  if (view.getUint16(4) !== 1) return undefined;
  const labels: string[] = [];
  let at = 12;
  for (;;) {
    if (at >= message.byteLength) return undefined;
    const length = message[at++];
    if (length === 0) break;
    // No compression in a question; labels are at most 63 bytes.
    if (length > 63 || at + length > message.byteLength) return undefined;
    labels.push(
      String.fromCharCode(...message.subarray(at, at + length)).toLowerCase(),
    );
    at += length;
  }
  if (at + 4 > message.byteLength) return undefined;
  return {
    id: view.getUint16(0),
    name: labels.join("."),
    type: view.getUint16(at),
    end: at + 4,
  };
}

/** The answer to `query` (its question echoed): `addresses` as A records,
 * or no records with `rcode`. */
export function dnsAnswer(
  query: Uint8Array,
  question: DnsQuestion,
  addresses: string[],
  rcode = 0,
): Uint8Array {
  const answers = addresses.map((ip) => ip.split(".").map(Number));
  const out = new Uint8Array(question.end + answers.length * 16);
  out.set(query.subarray(0, question.end));
  const view = new DataView(out.buffer);
  const rd = view.getUint16(2) & 0x0100;
  // QR, RD as asked, RA, the rcode.
  view.setUint16(2, 0x8000 | rd | 0x0080 | rcode);
  view.setUint16(6, answers.length);
  view.setUint16(8, 0);
  view.setUint16(10, 0);
  let at = question.end;
  for (const octets of answers) {
    view.setUint16(at, 0xc00c); // the question's name
    view.setUint16(at + 2, TYPE_A);
    view.setUint16(at + 4, CLASS_IN);
    view.setUint32(at + 6, DNS_TTL_S);
    view.setUint16(at + 10, 4);
    out.set(octets, at + 12);
    at += 16;
  }
  return out;
}

/** The reply to one DNS message, or `undefined` to drop it. */
export async function answerDns(
  query: Uint8Array,
  enabled: boolean,
  resolve: (name: string) => Promise<string[]>,
): Promise<Uint8Array | undefined> {
  const question = parseDnsQuery(query);
  if (question === undefined) return undefined;
  if (!enabled) return dnsAnswer(query, question, [], RCODE_REFUSED);
  // Only A records leave the tab: an AAAA (or any other) question has no
  // answer, which the resolver takes as "no such record of that type".
  if (question.type !== TYPE_A) {
    return dnsAnswer(
      query,
      question,
      [],
      question.type === 28 ? 0 : RCODE_NOTIMP,
    );
  }
  if (!question.name.includes(".")) {
    return dnsAnswer(query, question, [], RCODE_NXDOMAIN);
  }
  try {
    const addresses = await resolve(question.name);
    return dnsAnswer(
      query,
      question,
      addresses,
      addresses.length === 0 ? RCODE_NXDOMAIN : 0,
    );
  } catch (error) {
    console.warn(`[network] dns ${question.name}: ${error}`);
    return dnsAnswer(query, question, [], RCODE_SERVFAIL);
  }
}

const AF_INET = 2;
const SOCK_DGRAM = 2;
const SOCK_NONBLOCK = 0x800;
const MSG_DONTWAIT = 0x40;
const SYS_SOCKET_SENDTO = 0x1_0047;
const SYS_SOCKET_RECVFROM = 0x1_004B;
const DNS_MAX = 512;

/** Answer DNS on the guest's 127.0.0.1:53 as the kernel's own host
 * process, until `stop`. Throws when the port cannot be had. */
export function startDnsServer(
  mk: RelayKernel,
  answer: (query: Uint8Array) => Promise<Uint8Array | undefined>,
): { stop(): void } {
  const call = (method: number, req: Uint8Array, cap = 0) => {
    const { rc, response } = mk.syscall(method, req, cap);
    return { rc: Number(rc), response };
  };
  const open = new Uint8Array(8);
  open[0] = AF_INET;
  open[1] = SOCK_DGRAM;
  new DataView(open.buffer).setUint32(4, SOCK_NONBLOCK, true);
  const fd = call(METHOD.SYS_SOCKET_OPEN, open).rc;
  if (fd < 0) throw new Error(`dns socket: rc=${fd}`);
  const bind = fdRequest(fd, 16);
  const addr = new DataView(bind.buffer, 4, 16);
  addr.setUint16(0, AF_INET, true);
  addr.setUint16(2, DNS_PORT, false);
  bind.set([127, 0, 0, 1], 8);
  const bound = call(METHOD.SYS_SOCKET_BIND, bind).rc;
  if (bound !== 0) {
    call(METHOD.SYS_SOCKET_CLOSE, fdRequest(fd));
    throw new Error(`dns bind 127.0.0.1:${DNS_PORT}: rc=${bound}`);
  }
  let stopped = false;
  const reply = async (query: Uint8Array, from: Uint8Array) => {
    const response = await answer(query).catch(() => undefined);
    if (response === undefined || stopped) return;
    const req = new Uint8Array(12 + from.byteLength + response.byteLength);
    const view = new DataView(req.buffer);
    view.setUint32(0, fd, true);
    view.setUint32(4, MSG_DONTWAIT, true);
    view.setUint32(8, from.byteLength, true);
    req.set(from, 12);
    req.set(response, 12 + from.byteLength);
    call(SYS_SOCKET_SENDTO, req);
  };
  const wait = backoff();
  const poll = async () => {
    while (!stopped) {
      const req = new Uint8Array(16);
      const view = new DataView(req.buffer);
      view.setUint32(0, fd, true);
      view.setUint32(4, MSG_DONTWAIT, true);
      view.setUint32(8, DNS_MAX, true);
      view.setUint32(12, 16, true);
      let got: { rc: number; response: Uint8Array };
      try {
        got = call(SYS_SOCKET_RECVFROM, req, DNS_MAX + 8 + 16);
      } catch (error) {
        console.warn(`[network] dns stopped: ${error}`);
        return;
      }
      if (got.rc === -EAGAIN) {
        await wait.wait();
        continue;
      }
      if (got.rc < 0) {
        console.warn(`[network] dns recvfrom: rc=${got.rc}`);
        await wait.wait();
        continue;
      }
      wait.progressed();
      const meta = new DataView(got.response.buffer, got.response.byteOffset);
      const addrLen = meta.getUint32(DNS_MAX, true);
      const from = got.response.slice(DNS_MAX + 8, DNS_MAX + 8 + addrLen);
      void reply(got.response.slice(0, got.rc), from);
    }
  };
  void poll();
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      try {
        call(METHOD.SYS_SOCKET_CLOSE, fdRequest(fd));
      } catch {
        // The kernel is already gone.
      }
    },
  };
}

/** What /etc/resolv.conf says once the network is on. */
export const RESOLV_CONF = "nameserver 127.0.0.1\n";

/** One tab's network: the kernel's TCP backend, the DNS server, the
 * toggle. Made before the kernel (its backend goes into the kernel's host
 * state) and attached once the kernel is up. */
export class TabNetwork {
  readonly relay: RelayClient;
  readonly tcp: RelayTcp;
  #writeResolvConf: (() => void) | undefined;

  constructor(relayOrigin: string, changed: (status: NetworkStatus) => void) {
    this.relay = new RelayClient(relayOrigin);
    this.tcp = new RelayTcp(this.relay, changed);
  }

  /** Serve DNS in `mk`'s sandbox; `writeResolvConf` writes
   * {@link RESOLV_CONF} to /etc/resolv.conf, which turning the network
   * on does. Returns the stop. */
  attach(mk: RelayKernel, writeResolvConf: () => void): () => void {
    const dns = startDnsServer(
      mk,
      (query) =>
        answerDns(query, this.tcp.enabled, (name) => this.relay.resolve(name)),
    );
    this.#writeResolvConf = writeResolvConf;
    if (this.tcp.enabled) writeResolvConf();
    return () => {
      this.#writeResolvConf = undefined;
      dns.stop();
      this.tcp.setEnabled(false);
    };
  }

  setEnabled(on: boolean): void {
    if (on) this.#writeResolvConf?.();
    this.tcp.setEnabled(on);
  }
}
