import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { METHOD } from "@yurt/kernel-host-interface-js";
import {
  parseRequestHead,
  type RelayFetch,
  type RelayReply,
  relayReply,
  type RelayRequest,
  replyHead,
  startPkgRelay,
  upstreamUrl,
} from "../src/pkg_relay.ts";
import {
  browserTrustedRepos,
  INSTALL_MAX_BYTES,
  PACKAGE_REPO_URL,
  PKG_RELAY_URL,
  relayTrustedRepos,
  sha256Hex,
  TABLET_MAX_BYTES,
} from "../src/packages.ts";

const get = (target: string, headers: [string, string][] = []) =>
  parseRequestHead(
    [
      `GET ${target} HTTP/1.1`,
      "Host: 127.0.0.1:7417",
      ...headers.map(
        ([name, value]) => `${name}: ${value}`,
      ),
    ].join("\r\n"),
  )!;

/** A fetch answering `body` with `headers`, recording each call. */
function upstream(
  body: BodyInit,
  init: ResponseInit = {},
) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch: RelayFetch = (url, requestInit) => {
    calls.push({ url, init: requestInit });
    return Promise.resolve(new Response(body, init));
  };
  return { fetch, calls };
}

async function bodyOf(reply: RelayReply): Promise<Uint8Array> {
  if ("body" in reply) return reply.body;
  const parts: Uint8Array[] = [];
  for await (const chunk of reply.chunks) parts.push(chunk);
  return new Uint8Array(parts.flatMap((part) => [...part]));
}

const textOf = async (reply: RelayReply) =>
  new TextDecoder().decode(await bodyOf(reply));

const header = (reply: RelayReply, name: string) =>
  reply.headers.find(([n]) => n === name)?.[1];

Deno.test("parseRequestHead reads a request line and headers", () => {
  const request = get("/index.json", [["If-None-Match", '"x"']]);
  assertEquals(request.method, "GET");
  assertEquals(request.target, "/index.json");
  assertEquals(request.headers.get("if-none-match"), '"x"');
  assertEquals(parseRequestHead("GET /x"), undefined);
  assertEquals(parseRequestHead("GET /x HTTP/2"), undefined);
  assertEquals(parseRequestHead("GET /x HTTP/1.1\r\nno colon"), undefined);
});

Deno.test("upstreamUrl maps a path into the repository and nowhere else", () => {
  assertEquals(
    upstreamUrl("/packages/zsh.json"),
    `${PACKAGE_REPO_URL}packages/zsh.json`,
  );
  for (
    const target of [
      "packages/zsh.json",
      "/",
      "/../main2/index.json",
      "/a/../../x",
      "/%2e%2e/x",
      "/index.json?x=1",
      "/index.json#x",
      "/https://example.com/x",
      "//example.com/x",
      "/a b",
      `/${"a".repeat(513)}`,
    ]
  ) {
    const url = upstreamUrl(target);
    assert(typeof url !== "string", `${target} was let through: ${url}`);
  }
});

Deno.test("relayReply refuses other methods, bodies and paths without fetching", async () => {
  const { fetch, calls } = upstream("x");
  const options = { tablet: false, fetch };
  const post: RelayRequest = { ...get("/index.json"), method: "POST" };
  assertEquals((await relayReply(post, options)).status, 405);
  const head: RelayRequest = { ...get("/index.json"), method: "HEAD" };
  assertEquals((await relayReply(head, options)).status, 405);
  assertEquals(
    (await relayReply(get("/index.json", [["Content-Length", "3"]]), options))
      .status,
    400,
  );
  assertEquals(
    (await relayReply(
      get("/index.json", [["Transfer-Encoding", "chunked"]]),
      options,
    )).status,
    400,
  );
  assertEquals((await relayReply(get("/a/../../x"), options)).status, 403);
  assertEquals(calls, []);
});

Deno.test("relayReply fetches a simple GET: no guest header, no credentials, no redirect", async () => {
  const { fetch, calls } = upstream("{}");
  await relayReply(
    get("/packages/zsh.json", [["Authorization", "Bearer x"], [
      "If-None-Match",
      '"y"',
    ]]),
    { tablet: false, fetch },
  );
  assertEquals(calls.length, 1);
  const { url, init } = calls[0];
  assertEquals(url, `${PACKAGE_REPO_URL}packages/zsh.json`);
  assertEquals(init.method, "GET");
  assertEquals(init.redirect, "error");
  assertEquals(init.credentials, "omit");
  assertEquals(init.headers, undefined);
});

Deno.test("relayReply passes a 404 on and turns other failures into 502", async () => {
  const notFound = upstream("nope", { status: 404 });
  assertEquals(
    (await relayReply(get("/x.json"), { tablet: false, fetch: notFound.fetch }))
      .status,
    404,
  );
  const broken = upstream("oops", { status: 500 });
  const reply = await relayReply(get("/x.json"), {
    tablet: false,
    fetch: broken.fetch,
  });
  assertEquals(reply.status, 502);
  assertStringIncludes(await textOf(reply), "HTTP 500");
  const thrown = await relayReply(get("/x.json"), {
    tablet: false,
    fetch: () => Promise.reject(new TypeError("redirect refused")),
  });
  assertEquals(thrown.status, 502);
  assertStringIncludes(await textOf(thrown), "redirect refused");
});

Deno.test("relayReply sends metadata with its own length, not the upstream's (gzip)", async () => {
  // GitHub gzips metadata and signatures: the Content-Length the browser
  // exposes is the compressed size.
  const body = '{"name":"zsh","versions":[]}';
  const { fetch } = upstream(body, { headers: { "content-length": "12" } });
  for (const path of ["/packages/zsh.json", "/artifacts/zsh.yurtpkg.bundle"]) {
    const reply = await relayReply(get(path), { tablet: false, fetch });
    assertEquals(reply.status, 200);
    assert("body" in reply);
    assertEquals(await textOf(reply), body);
    assertStringIncludes(
      new TextDecoder().decode(replyHead(reply)),
      `Content-Length: ${body.length}\r\n`,
    );
    // Not one pkg asks for conditionally.
    assertEquals(header(reply, "ETag"), undefined);
  }
});

Deno.test("relayReply refuses metadata over 4 MiB", async () => {
  const { fetch } = upstream(new Uint8Array(4 * 1024 * 1024 + 1));
  const reply = await relayReply(get("/packages/big.json"), {
    tablet: false,
    fetch,
  });
  assertEquals(reply.status, 502);
});

Deno.test("relayReply gives the index an ETag of its bytes and a 304 for it", async () => {
  const index = '{"schema":1,"index_version":43}';
  const etag = `"sha256-${await sha256Hex(new TextEncoder().encode(index))}"`;
  for (const path of ["/index.json", "/index.json.bundle"]) {
    const { fetch } = upstream(index);
    const first = await relayReply(get(path), { tablet: false, fetch });
    assertEquals(first.status, 200);
    assertEquals(header(first, "ETag"), etag);
    assertEquals(await textOf(first), index);
    const again = await relayReply(get(path, [["If-None-Match", etag]]), {
      tablet: false,
      fetch: upstream(index).fetch,
    });
    assertEquals(again.status, 304);
    assertEquals((await bodyOf(again)).byteLength, 0);
    // A newer index: the old validator does not match.
    const newer = await relayReply(get(path, [["If-None-Match", etag]]), {
      tablet: false,
      fetch: upstream(`${index} `).fetch,
    });
    assertEquals(newer.status, 200);
  }
});

Deno.test("relayReply streams an archive under its exact length", async () => {
  const archive = new Uint8Array(100_000).map((_, i) => i & 0xff);
  const seen: number[] = [];
  const { fetch } = upstream(archive, {
    headers: { "content-length": String(archive.byteLength) },
  });
  const reply = await relayReply(get("/artifacts/a.yurtpkg"), {
    tablet: false,
    fetch,
    onFetch: (_, received) => seen.push(received),
  });
  assert("chunks" in reply);
  assertEquals(reply.length, archive.byteLength);
  assertEquals(await bodyOf(reply), archive);
  assertEquals(seen.at(-1), archive.byteLength);
});

Deno.test("relayReply cuts an archive whose body is not its Content-Length", async () => {
  for (const [length, actual] of [[10, 9], [10, 11]]) {
    const { fetch } = upstream(new Uint8Array(actual), {
      headers: { "content-length": String(length) },
    });
    const reply = await relayReply(get("/artifacts/a.yurtpkg"), {
      tablet: false,
      fetch,
    });
    assert("chunks" in reply);
    await assertRejects(() => bodyOf(reply));
  }
});

Deno.test("relayReply caps an archive per device", async () => {
  const over = (bytes: number) =>
    upstream(new ReadableStream(), {
      headers: { "content-length": String(bytes) },
    }).fetch;
  const tablet = await relayReply(get("/artifacts/a.yurtpkg"), {
    tablet: true,
    fetch: over(TABLET_MAX_BYTES + 1),
  });
  assertEquals(tablet.status, 502);
  assertStringIncludes(await textOf(tablet), "tablet limit");
  const desktop = await relayReply(get("/artifacts/a.yurtpkg"), {
    tablet: false,
    fetch: over(INSTALL_MAX_BYTES + 1),
  });
  assertEquals(desktop.status, 502);
  const fits = await relayReply(get("/artifacts/a.yurtpkg"), {
    tablet: false,
    fetch: over(TABLET_MAX_BYTES + 1),
  });
  assertEquals(fits.status, 200);
  if ("cancel" in fits) fits.cancel();
});

Deno.test("relayReply gives up on a fetch that stalls", async () => {
  const stalled: RelayFetch = (_, init) =>
    new Promise((_, reject) =>
      init.signal!.addEventListener("abort", () => reject(init.signal!.reason))
    );
  const reply = await relayReply(get("/index.json"), {
    tablet: false,
    fetch: stalled,
    stallMs: 20,
  });
  assertEquals(reply.status, 502);
  assertStringIncludes(await textOf(reply), "no data");
});

Deno.test("replyHead closes the connection and states the length", () => {
  const head = new TextDecoder().decode(replyHead({
    status: 404,
    headers: [["Content-Type", "text/plain"]],
    body: new Uint8Array(5),
  }));
  assertEquals(
    head,
    "HTTP/1.1 404 Not Found\r\nContent-Length: 5\r\nConnection: close\r\n" +
      "Content-Type: text/plain\r\n\r\n",
  );
});

const IMAGE_TOML = `# pkg's trusted repositories
[[repo]]
id              = "local"
url             = "file:///srv/repo/"
priority        = 5
signing_subject = "s"
signing_issuer  = "i"

[[repo]]
id              = "official"
url             = "https://raw.githubusercontent.com/YurtOS/yurt-packages/main/"
priority        = 0
signing_subject = "https://github.com/YurtOS/yurt-packages/.github/workflows/release.yml@refs/heads/main"
signing_issuer  = "https://token.actions.githubusercontent.com"
`;

Deno.test("relayTrustedRepos changes only the packages repository's url, once", () => {
  const relayed = relayTrustedRepos(IMAGE_TOML)!;
  const before = IMAGE_TOML.split("\n");
  const after = relayed.split("\n");
  // Everything but that one line is kept, in order.
  assertEquals(
    after.filter((line) => !line.startsWith("#") && !line.startsWith("url")),
    before.filter((line) => !line.startsWith("#") && !line.startsWith("url")),
  );
  assert(after.includes('url             = "file:///srv/repo/"'));
  assert(after.includes(`url = "${PKG_RELAY_URL}"`));
  assert(!relayed.includes('url             = "https://raw'));
  assertEquals(relayTrustedRepos(relayed), undefined);
  assertEquals(
    relayTrustedRepos('[[repo]]\nid = "x"\nurl = "file:///r/"\n'),
    undefined,
  );
});

Deno.test("browserTrustedRepos finds the packages repository at the relay", () => {
  const staged = browserTrustedRepos(
    relayTrustedRepos(IMAGE_TOML)!,
    "file:///staging/repo/",
  );
  assertEquals(staged.id, "official");
  assertStringIncludes(staged.toml, 'url = "file:///staging/repo/"');
  assertStringIncludes(
    staged.toml,
    'signing_issuer = "https://token.actions.githubusercontent.com"',
  );
});

/** A kernel whose listener has nothing to accept, counting the calls. */
function idleKernel() {
  const calls: number[] = [];
  return {
    calls,
    kernel: {
      scratchLen: 1 << 20,
      syscall(method: number) {
        calls.push(method);
        if (method === METHOD.SYS_SOCKET_OPEN) {
          return { rc: 7n, response: new Uint8Array() };
        }
        if (method === METHOD.SYS_SOCKET_ACCEPT) {
          return { rc: -11n, response: new Uint8Array() };
        }
        return { rc: 0n, response: new Uint8Array() };
      },
    },
  };
}

Deno.test("startPkgRelay polls accept while it runs, and calls nothing after stop", async () => {
  const { calls, kernel } = idleKernel();
  const relay = startPkgRelay(kernel, { tablet: false });
  await new Promise((r) => setTimeout(r, 250));
  const accepts = calls.filter((m) => m === METHOD.SYS_SOCKET_ACCEPT).length;
  // Every 100 ms, not a spin.
  assert(accepts >= 2 && accepts <= 5, `${accepts} accepts in 250 ms`);
  relay.stop();
  assertEquals(calls.at(-1), METHOD.SYS_SOCKET_CLOSE);
  const stopped = calls.length;
  await new Promise((r) => setTimeout(r, 250));
  assertEquals(calls.length, stopped);
});

Deno.test("startPkgRelay throws when the port cannot be bound", () => {
  const { kernel } = idleKernel();
  const refusing = {
    ...kernel,
    syscall(method: number) {
      if (method === METHOD.SYS_SOCKET_BIND) {
        return { rc: -98n, response: new Uint8Array() };
      }
      return kernel.syscall(method);
    },
  };
  let error: unknown;
  try {
    startPkgRelay(refusing, { tablet: false });
  } catch (e) {
    error = e;
  }
  assert(error instanceof Error);
  assertStringIncludes(error.message, "bind 127.0.0.1:7417: rc=-98");
});

Deno.test("relayTrustedRepos leaves a file it cannot read as it is", () => {
  assertEquals(relayTrustedRepos("[[repo]]\nenabled = true\n"), undefined);
  assertEquals(relayTrustedRepos("[repo.extra]\nx = 1\n"), undefined);
});

Deno.test("relayReply refuses an archive with no Content-Length", async () => {
  const { fetch } = upstream(new Uint8Array(10));
  const reply = await relayReply(get("/artifacts/a.yurtpkg"), {
    tablet: false,
    fetch,
  });
  assertEquals(reply.status, 502);
  assertStringIncludes(await textOf(reply), "no Content-Length");
});

/** A fetch that answers only when aborted, with the abort's reason. */
const hanging: RelayFetch = (_, init) =>
  new Promise((_, reject) =>
    init.signal!.addEventListener("abort", () => reject(init.signal!.reason))
  );

/** A kernel with one connection to accept, whose request head arrives
 * after one EAGAIN, and which records every call. */
function busyKernel(head: string) {
  const calls: number[] = [];
  let accepted = false;
  let recvs = 0;
  return {
    calls,
    kernel: {
      scratchLen: 1 << 20,
      syscall(method: number, _request: Uint8Array, cap: number) {
        calls.push(method);
        const none = new Uint8Array();
        switch (method) {
          case METHOD.SYS_SOCKET_OPEN:
            return { rc: 7n, response: none };
          case METHOD.SYS_SOCKET_ACCEPT:
            if (accepted) return { rc: -11n, response: none };
            accepted = true;
            return { rc: 9n, response: none };
          case METHOD.SYS_SOCKET_RECV: {
            if (recvs++ === 0) return { rc: -11n, response: none };
            const bytes = new TextEncoder().encode(head).slice(0, cap);
            return { rc: BigInt(bytes.byteLength), response: bytes };
          }
          default:
            return { rc: 0n, response: none };
        }
      },
    },
  };
}

Deno.test("stop ends a connection mid-fetch: its fetch is aborted, and nothing calls the kernel after", async () => {
  const { calls, kernel } = busyKernel("GET /index.json HTTP/1.1\r\n\r\n");
  let fetched: AbortSignal | undefined;
  const relay = startPkgRelay(kernel, {
    tablet: false,
    fetch: (url, init) => {
      fetched = init.signal!;
      return hanging(url, init);
    },
  });
  for (let i = 0; i < 100 && fetched === undefined; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  assert(fetched !== undefined, "the request never reached the fetch");
  relay.stop();
  const stopped = calls.length;
  assert(fetched.aborted);
  await new Promise((r) => setTimeout(r, 300));
  assertEquals(calls.slice(stopped), []);
  // The connection and the listener were closed, once each.
  assertEquals(
    calls.filter((m) => m === METHOD.SYS_SOCKET_CLOSE).length,
    2,
  );
});

Deno.test("a kernel that throws stops the relay instead of killing its loop", async () => {
  const { kernel } = idleKernel();
  let throwing = false;
  const calls: number[] = [];
  const relay = startPkgRelay({
    ...kernel,
    syscall(method: number) {
      calls.push(method);
      if (throwing) throw new Error("kernel trapped");
      return kernel.syscall(method);
    },
  }, { tablet: false });
  throwing = true;
  await new Promise((r) => setTimeout(r, 250));
  const after = calls.length;
  await new Promise((r) => setTimeout(r, 250));
  assertEquals(calls.length, after);
  relay.stop();
});
