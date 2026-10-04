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
    app: "datasette",
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
        "Bearer example",
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
  assertStringIncludes(c.written(), "Authorization: Bearer example\r\n");
  assertEquals(c.closed(), 1);
});
Deno.test("guest HTTP uses the service port supplied by the browser session", async () => {
  const c = connection(
    `HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:8123${prefix}orders/\r\nContent-Length: 0\r\n\r\n`,
  );
  const reply = await requestGuestHttp(
    async () => c.conn,
    options({ port: 8123 }),
  );
  assertEquals(new Headers(reply.headers).get("location"), prefix + "orders/");
  assertStringIncludes(c.written(), "Host: 127.0.0.1:8123\r\n");
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

Deno.test("POST sends binary body with length, Origin, mapped Referer, and jar cookie", async () => {
  const c = connection("HTTP/1.1 204 No Content\r\n\r\n");
  const body = new Uint8Array([0xff, 0x00, 0xfe, 0x80]).buffer;
  await requestGuestHttp(
    async () => c.conn,
    options({
      method: "POST",
      path: prefix + "form",
      body,
      referrer: prefix + "page?x=1",
      headers: [["Content-Type", "application/octet-stream"], [
        "X-CSRF-Token",
        "t",
      ], ["Cookie", "evil=1"]],
      cookie: "sid=1",
    }),
  );
  const wire = c.written();
  assertStringIncludes(wire, "POST " + prefix + "form HTTP/1.1\r\n");
  assertStringIncludes(wire, "Content-Length: 4\r\n");
  assertStringIncludes(wire, "Origin: http://127.0.0.1:8001\r\n");
  assertStringIncludes(
    wire,
    `Referer: http://127.0.0.1:8001${prefix}page?x=1\r\n`,
  );
  assertStringIncludes(wire, "X-CSRF-Token: t\r\n");
  assertStringIncludes(wire, "Cookie: sid=1\r\n");
  assertEquals(wire.includes("evil=1"), false);
});

Deno.test("empty POST sends zero length; GET omits Origin and Referer", async () => {
  const post = connection("HTTP/1.1 204 No Content\r\n\r\n");
  await requestGuestHttp(async () => post.conn, options({ method: "POST" }));
  assertStringIncludes(post.written(), "Content-Length: 0\r\n");
  const get = connection("HTTP/1.1 204 No Content\r\n\r\n");
  await requestGuestHttp(async () => get.conn, options({ referrer: prefix }));
  assertEquals(/Origin:|Referer:/.test(get.written()), false);
});

Deno.test("request body bytes follow the head unchanged", async () => {
  const bytes = new Uint8Array([0, 1, 2, 255]);
  const writes: Uint8Array[] = [];
  const conn: GuestConnection = {
    write: async (b) => {
      writes.push(b.slice());
    },
    read: async () => enc.encode("HTTP/1.1 204 No Content\r\n\r\n"),
    close: async () => {},
  };
  await requestGuestHttp(
    async () => conn,
    options({ method: "PUT", body: bytes.buffer }),
  );
  const wire = new Uint8Array(writes.reduce((n, b) => n + b.length, 0));
  let at = 0;
  for (const b of writes) {
    wire.set(b, at);
    at += b.length;
  }
  assertEquals([...wire.slice(-4)], [0, 1, 2, 255]);
});

Deno.test("invalid methods and request body sizes fail before dialing", async () => {
  const never = async (): Promise<GuestConnection> => {
    throw new Error("must not dial");
  };
  const big = new ArrayBuffer(16 * 1024 * 1024 + 1);
  const tooBig = await assertRejects(
    () => requestGuestHttp(never, options({ method: "POST", body: big })),
    GuestHttpError,
  );
  assertEquals((tooBig as GuestHttpError).status, 413);
  const onGet = await assertRejects(
    () => requestGuestHttp(never, options({ body: new ArrayBuffer(1) })),
    GuestHttpError,
  );
  assertEquals((onGet as GuestHttpError).status, 400);
  const unknown = await assertRejects(
    () =>
      requestGuestHttp(
        never,
        options({ method: "TRACE" as GuestHttpOptions["method"] }),
      ),
    GuestHttpError,
  );
  assertEquals((unknown as GuestHttpError).status, 405);
});

Deno.test("oversized request head fails with 431 before dialing", async () => {
  let dialed = false;
  const err = await assertRejects(() =>
    requestGuestHttp(async () => {
      dialed = true;
      return connection("").conn;
    }, options({ cookie: "a=" + "x".repeat(64 * 1024) })), GuestHttpError);
  assertEquals((err as GuestHttpError).status, 431);
  assertEquals(dialed, false);
});

Deno.test("response head Set-Cookie is collected and stripped while trailer cookie is ignored", async () => {
  const c = connection(
    `HTTP/1.1 303 See Other\r\nSet-Cookie: sid=1; Path=${prefix}\r\nSet-Cookie: b=2\r\nLocation: ${prefix}home\r\nTransfer-Encoding: chunked\r\n\r\n0\r\nSet-Cookie: trailer=1\r\n\r\n`,
  );
  const reply = await requestGuestHttp(
    async () => c.conn,
    options({ method: "POST" }),
  );
  assertEquals(reply.setCookies, [`sid=1; Path=${prefix}`, "b=2"]);
  assertEquals(new Headers(reply.headers).get("set-cookie"), null);
  assertEquals(new Headers(reply.headers).get("location"), prefix + "home");
});

Deno.test("fixed response reserves before body read and closes on rejection", async () => {
  const seen: number[] = [];
  const c = connection(
    "HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\n0123456789",
    4,
  );
  const reply = await requestGuestHttp(
    async () => c.conn,
    options({ onBuffer: (n) => seen.push(n) }),
  );
  assertEquals(dec.decode(reply.body), "0123456789");
  assertEquals(seen, [10]);
  let reads = 0;
  let closed = false;
  const conn: GuestConnection = {
    write: async () => {},
    read: async () => {
      reads++;
      if (reads === 1) {
        return enc.encode("HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\n");
      }
      throw new Error("body read before budget approval");
    },
    close: async () => {
      closed = true;
    },
  };
  await assertRejects(
    () =>
      requestGuestHttp(
        async () => conn,
        options({
          onBuffer: () => {
            throw new GuestHttpError("session buffer limit", 503);
          },
        }),
      ),
    GuestHttpError,
    "buffer limit",
  );
  assertEquals(reads, 1);
  assertEquals(closed, true);
});

Deno.test("chunk reservation precedes body read and rejected chunk closes", async () => {
  let reads = 0;
  let closed = false;
  const parts = [
    "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n",
    "4\r\n",
  ];
  const conn: GuestConnection = {
    write: async () => {},
    read: async () => {
      reads++;
      if (reads <= parts.length) return enc.encode(parts[reads - 1]);
      throw new Error("chunk body read before reservation");
    },
    close: async () => {
      closed = true;
    },
  };
  await assertRejects(
    () =>
      requestGuestHttp(
        async () => conn,
        options({
          onBuffer: () => {
            throw new GuestHttpError("budget", 503);
          },
        }),
      ),
    GuestHttpError,
    "budget",
  );
  assertEquals(reads, 2);
  assertEquals(closed, true);
});

Deno.test("EOF body copies reserve retained bytes", async () => {
  const seen: number[] = [];
  const c = connection("HTTP/1.1 200 OK\r\n\r\nhello", 4096);
  const r = await requestGuestHttp(
    async () => c.conn,
    options({ onBuffer: (n) => seen.push(n) }),
  );
  assertEquals(dec.decode(r.body), "hello");
  assertEquals(seen, [5]);
});

Deno.test("multiple chunks reserve their final copy before allocation", async () => {
  const wire =
    "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n4\r\nabcd\r\n4\r\nefgh\r\n0\r\n\r\n";
  const seen: number[] = [];
  const c = connection(wire, 4096);
  const r = await requestGuestHttp(
    async () => c.conn,
    options({ onBuffer: (n) => seen.push(n) }),
  );
  assertEquals(dec.decode(r.body), "abcdefgh");
  assertEquals(seen, [4, 4, 8]);
  let charged = 0;
  const rejected = connection(wire, 4096);
  await assertRejects(
    () =>
      requestGuestHttp(
        async () => rejected.conn,
        options({
          onBuffer: (n) => {
            if (charged + n > 12) throw new GuestHttpError("budget", 503);
            charged += n;
          },
        }),
      ),
    GuestHttpError,
    "budget",
  );
  assertEquals(charged, 8);
  assertEquals(rejected.closed(), 1);
});

Deno.test("one chunk returns with one reservation", async () => {
  const seen: number[] = [];
  const c = connection(
    "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n4\r\nabcd\r\n0\r\n\r\n",
    4096,
  );
  const r = await requestGuestHttp(
    async () => c.conn,
    options({ onBuffer: (n) => seen.push(n) }),
  );
  assertEquals(dec.decode(r.body), "abcd");
  assertEquals(seen, [4]);
});

Deno.test("OPTIONS 204 and HEAD and 304 finish without response bodies", async () => {
  for (
    const [method, wire] of [
      ["HEAD", "HTTP/1.1 200 OK\r\nContent-Length: 9\r\n\r\n"],
      ["OPTIONS", "HTTP/1.1 204 No Content\r\nAllow: GET\r\n\r\n"],
      ["GET", "HTTP/1.1 304 Not Modified\r\n\r\n"],
    ] as const
  ) {
    const r = await requestGuestHttp(
      async () => connection(wire).conn,
      options({ method }),
    );
    assertEquals(r.body.byteLength, 0);
  }
});
