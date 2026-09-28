// deno-lint-ignore-file require-await
// In-memory connections implement the asynchronous host socket interface.
import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
  type GuestConnection,
  GuestHttpError,
  type GuestHttpOptions,
  requestGuestHttp,
} from "../src/guest_http.ts";
const session = "11111111-1111-4111-8111-111111111111";
const prefix = `/apps/datasette/${session}/`;
const enc = new TextEncoder();
const dec = new TextDecoder();
function options(extra: Partial<GuestHttpOptions> = {}): GuestHttpOptions {
  return {
    session,
    prefix,
    method: "GET",
    path: prefix + "orders",
    headers: [],
    signal: new AbortController().signal,
    ...extra,
  };
}
function connection(wire: string, fragment = 1) {
  let offset = 0;
  let writes = "";
  let closes = 0;
  const bytes = enc.encode(wire);
  const conn: GuestConnection = {
    write: async (b) => {
      writes += dec.decode(b);
    },
    read: async (n) => {
      const end = Math.min(bytes.length, offset + Math.min(n, fragment));
      const result = bytes.slice(offset, end);
      offset = end;
      return result;
    },
    close: async () => {
      closes++;
    },
  };
  return { conn, written: () => writes, closed: () => closes };
}
Deno.test("guest HTTP decodes fragmented length body and sends only permitted headers", async () => {
  const c = connection(
    "HTTP/1.1 200 OK\r\nContent-Length: 5\r\nContent-Type: text/plain\r\nConnection: close, X-Private\r\nX-Private: secret\r\n\r\nhello",
  );
  const reply = await requestGuestHttp(
    async () => c.conn,
    options({
      headers: [["Accept", "text/plain"], ["Cookie", "secret"], [
        "Authorization",
        "secret",
      ]],
    }),
  );
  assertEquals(dec.decode(reply.body), "hello");
  assertEquals(new Headers(reply.headers).get("x-private"), null);
  assertStringIncludes(c.written(), "Host: 127.0.0.1:8001\r\n");
  assertStringIncludes(
    c.written(),
    "Connection: close\r\nAccept-Encoding: identity\r\n",
  );
  assertEquals(c.written().includes("secret"), false);
  assertEquals(c.closed(), 1);
});
Deno.test("guest HTTP dechunks extensions and consumes trailers", async () => {
  const c = connection(
    "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2;foo=bar\r\nhi\r\n3\r\nbye\r\n0\r\nX-Trailer: yes\r\n\r\n",
  );
  const r = await requestGuestHttp(async () => c.conn, options());
  assertEquals(dec.decode(r.body), "hibye");
  assertEquals(new Headers(r.headers).get("content-length"), "5");
  assertEquals(new Headers(r.headers).get("transfer-encoding"), null);
});
Deno.test("guest HTTP finishes an EOF-delimited body at first EOF", async () => {
  const c = connection(
    "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\nhello",
    4096,
  );
  assertEquals(
    dec.decode((await requestGuestHttp(async () => c.conn, options())).body),
    "hello",
  );
});
for (
  const [method, status] of [["HEAD", 200], ["GET", 204], ["GET", 304]] as const
) {
  Deno.test(`guest HTTP ${method} ${status} ignores representation body length`, async () => {
    let reads = 0;
    const r = await requestGuestHttp(async () => ({
      write: async () => {},
      close: async () => {},
      read: async () => {
        if (reads++) throw new Error("body read");
        return enc.encode(
          `HTTP/1.1 ${status} OK\r\nContent-Length: 999\r\n\r\n`,
        );
      },
    }), options({ method }));
    assertEquals(r.body.byteLength, 0);
    assertEquals(reads, 1);
  });
}
const invalid = [
  "Content-Length: 1\r\nContent-Length: 1\r\n",
  "Content-Length: 1\r\nTransfer-Encoding: chunked\r\n",
  "Content-Length: -1\r\n",
  "Content-Length: 1x\r\n",
  "Transfer-Encoding: gzip\r\n",
  "Content-Encoding: gzip\r\n",
  "Set-Cookie: secret=1\r\n",
  "bad header\r\n",
  "Content-Length: 16777217\r\n",
];
for (const headers of invalid) {
  Deno.test(`guest HTTP rejects unsupported framing ${headers.trim()}`, async () => {
    const c = connection(`HTTP/1.1 200 OK\r\n${headers}\r\nx`);
    await assertRejects(
      () => requestGuestHttp(async () => c.conn, options()),
      GuestHttpError,
    );
    assertEquals(c.closed(), 1);
  });
}
for (
  const wire of [
    "HTTP/1.1 200 OK\r\nContent-Length: 4\r\n\r\nabc",
    "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nZ\r\n",
    "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2\r\nx",
    "HTTP/1.1 101 Switching Protocols\r\n\r\n",
    "HTTP/1.1 200 OK\r\nX-Long: " + "a".repeat(65536) + "\r\n\r\n",
  ]
) {
  Deno.test(
    "guest HTTP rejects truncated, invalid or oversized wire " +
      wire.slice(0, 55),
    async () => {
      const c = connection(wire, 4096);
      await assertRejects(
        () => requestGuestHttp(async () => c.conn, options()),
        GuestHttpError,
      );
    },
  );
}
Deno.test("guest HTTP allows eight informational responses and rejects the ninth", async () => {
  for (const count of [8, 9]) {
    const c = connection(
      "HTTP/1.1 100 Continue\r\n\r\n".repeat(count) +
        "HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n",
      4096,
    );
    if (count === 8) {
      assertEquals(
        (await requestGuestHttp(async () => c.conn, options())).status,
        200,
      );
    } else {await assertRejects(() =>
        requestGuestHttp(async () => c.conn, options()), GuestHttpError);}
  }
});
Deno.test("guest HTTP rebases only redirects inside this session", async () => {
  for (
    const [location, expected] of [["orders?x=1", prefix + "orders?x=1"], [
      `http://127.0.0.1:8001${prefix}orders`,
      prefix + "orders",
    ]]
  ) {
    const c = connection(
      `HTTP/1.1 302 Found\r\nLocation: ${location}\r\nContent-Length: 0\r\n\r\n`,
    );
    const r = await requestGuestHttp(async () => c.conn, options());
    assertEquals(new Headers(r.headers).get("location"), expected);
  }
  for (
    const location of [
      "https://example.org/",
      "/other",
      "../other/",
      "%2e%2e/other",
      "http://localhost:8001/",
    ]
  ) {
    const c = connection(
      `HTTP/1.1 302 Found\r\nLocation: ${location}\r\nContent-Length: 0\r\n\r\n`,
    );
    await assertRejects(
      () => requestGuestHttp(async () => c.conn, options()),
      GuestHttpError,
    );
  }
});
Deno.test("guest HTTP rejects path injection before opening connection", async () => {
  let dials = 0;
  for (
    const path of [
      prefix + "orders\r\nInjected: yes",
      "/outside",
      prefix + "%2f..%2foutside",
      prefix + "orders#fragment",
    ]
  ) {
    await assertRejects(() =>
      requestGuestHttp(async () => {
        dials++;
        return connection("").conn;
      }, options({ path })), GuestHttpError);
  }
  assertEquals(dials, 0);
});
Deno.test("guest HTTP aborts an in-flight read and closes once", async () => {
  const ac = new AbortController();
  let closes = 0;
  const reading = Promise.withResolvers<void>();
  const pending = requestGuestHttp(
    async () => ({
      write: async () => {},
      read: () => {
        reading.resolve();
        return new Promise(() => {});
      },
      close: async () => {
        closes++;
      },
    }),
    options({ signal: ac.signal }),
  );
  await reading.promise;
  ac.abort();
  await assertRejects(() => pending, DOMException);
  assertEquals(closes, 1);
});
Deno.test("guest HTTP closes late dial completion after timeout", async () => {
  const dial = Promise.withResolvers<GuestConnection>();
  let closes = 0;
  const pending = requestGuestHttp(
    () => dial.promise,
    options({ timeoutMs: 5 }),
  );
  const e = await assertRejects(() => pending, GuestHttpError);
  assertEquals((e as GuestHttpError).status, 504);
  dial.resolve({
    write: async () => {},
    read: async () => new Uint8Array(),
    close: async () => {
      closes++;
    },
  });
  await new Promise((r) => setTimeout(r, 0));
  assertEquals(closes, 1);
});
Deno.test("guest HTTP already-aborted request never dials", async () => {
  const ac = new AbortController();
  ac.abort();
  let dials = 0;
  await assertRejects(() =>
    requestGuestHttp(async () => {
      dials++;
      return connection("").conn;
    }, options({ signal: ac.signal })), DOMException);
  assertEquals(dials, 0);
});
Deno.test("guest HTTP bounds EOF body without a length header", async () => {
  let reads = 0;
  let closes = 0;
  const body = new Uint8Array(8192);
  const pending = requestGuestHttp(async () => ({
    write: async () => {},
    close: async () => {
      closes++;
    },
    read: async () =>
      reads++ === 0 ? enc.encode("HTTP/1.1 200 OK\r\n\r\n") : body,
  }), options());
  const error = await assertRejects(() => pending, GuestHttpError);
  assertEquals((error as GuestHttpError).status, 502);
  assertEquals(closes, 1);
});
Deno.test("guest HTTP times out a stalled read and closes once", async () => {
  let closes = 0;
  const pending = requestGuestHttp(
    async () => ({
      write: async () => {},
      read: () => new Promise(() => {}),
      close: async () => {
        closes++;
      },
    }),
    options({ timeoutMs: 5 }),
  );
  const error = await assertRejects(() => pending, GuestHttpError);
  assertEquals((error as GuestHttpError).status, 504);
  assertEquals(closes, 1);
});
Deno.test("guest HTTP trailer bytes share the header limit", async () => {
  const c = connection(
    "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n0\r\nX-Trailer: " +
      "a".repeat(65500) + "\r\n\r\n",
    8192,
  );
  await assertRejects(
    () => requestGuestHttp(async () => c.conn, options()),
    GuestHttpError,
  );
});
