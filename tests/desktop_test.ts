import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "node:path";
import { handleDistRequest, startDesktopServer } from "../src/desktop.ts";
import { desktopInfo } from "../src/native.ts";
import { inlineScriptHashes } from "../src/csp.ts";

const isolation = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Resource-Policy": "same-origin",
};

/** A stand-in for dist/: the page, a Jupyter document and one image part. */
async function fakeDist(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "desktop-dist-" });
  await Deno.writeTextFile(
    join(dir, "index.html"),
    "<html><script>console.log(crossOriginIsolated)</script></html>\n",
  );
  await Deno.mkdir(join(dir, "jupyter/lab"), { recursive: true });
  await Deno.writeTextFile(
    join(dir, "jupyter/lab/index.html"),
    "<html><script>window.lab = 1</script></html>\n",
  );
  await Deno.writeFile(
    join(dir, "playground.yurtimg.0"),
    new Uint8Array([1, 2, 3]),
  );
  return dir;
}

function assertIsolated(res: Response) {
  for (const [name, value] of Object.entries(isolation)) {
    assertEquals(res.headers.get(name), value, name);
  }
}

Deno.test("desktop server serves dist/ with the isolation headers", async () => {
  const dist = await fakeDist();
  try {
    const handle = handleDistRequest(dist);
    const home = await handle(new Request("http://desktop/"));
    assertEquals(home.status, 200);
    assertIsolated(home);
    assertEquals(home.headers.get("content-type"), "text/html; charset=utf-8");
    const html = await home.text();
    assertStringIncludes(html, "crossOriginIsolated");
    // The document allows its own inline script by hash, like the dev server.
    const [hash] = await inlineScriptHashes(html);
    assertStringIncludes(home.headers.get("Content-Security-Policy")!, hash);

    const part = await handle(
      new Request("http://desktop/playground.yurtimg.0"),
    );
    assertEquals(part.status, 200);
    assertIsolated(part);
    assertEquals(part.headers.get("content-type"), "application/octet-stream");
    assertEquals(
      new Uint8Array(await part.arrayBuffer()),
      new Uint8Array([1, 2, 3]),
    );
  } finally {
    await Deno.remove(dist, { recursive: true });
  }
});

Deno.test("desktop server gives Jupyter documents the eval allowance", async () => {
  const dist = await fakeDist();
  try {
    const handle = handleDistRequest(dist);
    const lab = await handle(
      new Request("http://desktop/jupyter/lab/index.html"),
    );
    assertEquals(lab.status, 200);
    assertIsolated(lab);
    assertStringIncludes(
      lab.headers.get("Content-Security-Policy")!,
      "'unsafe-eval'",
    );
    await lab.body?.cancel();
    const home = await handle(new Request("http://desktop/"));
    assertEquals(
      home.headers.get("Content-Security-Policy")!.includes("'unsafe-eval'"),
      false,
    );
    await home.body?.cancel();
  } finally {
    await Deno.remove(dist, { recursive: true });
  }
});

Deno.test("desktop server 404s carry the isolation headers and stay in dist/", async () => {
  const dist = await fakeDist();
  try {
    const handle = handleDistRequest(dist);
    for (const path of ["/nope", "/../desktop_test.ts", "/%zz", "/jupyter/"]) {
      // /jupyter/ is a directory without an index here (the real site's has
      // one); a directory with nothing to serve is still a 404.
      const res = await handle(new Request(`http://desktop${path}`));
      assertEquals(res.status, 404, path);
      assertIsolated(res);
      await res.body?.cancel();
    }
  } finally {
    await Deno.remove(dist, { recursive: true });
  }
});

Deno.test("desktop build ships the launcher with dist/ and runtime/ in the bundle", async () => {
  const script = await Deno.readTextFile(
    new URL("../scripts/build-desktop.sh", import.meta.url),
  );
  for (
    const value of [
      "deno compile",
      "scripts/desktop.ts",
      "--allow-run",
      "Info.plist",
      "Contents/Resources/dist",
      "Contents/Resources/runtime",
      "install-desktop-host.sh",
      "x86_64-unknown-linux-gnu",
      "hdiutil create",
      "debian-binary",
      "/usr/bin/yurt-playground",
    ]
  ) {
    assertStringIncludes(script, value);
  }
});

Deno.test("home page links the installers and CLI packages the merge workflow releases", async () => {
  const html = await Deno.readTextFile(
    new URL("../public/index.html", import.meta.url),
  );
  const workflow = await Deno.readTextFile(
    new URL("../.github/workflows/ci.yml", import.meta.url),
  );
  // `releases/latest/download/<asset>` is the one URL that survives every
  // release, so the page can link it before the release exists.
  const prefix =
    "https://github.com/YurtOS/yurt-playground/releases/latest/download/";
  const links = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]).filter(
    (href) => href.startsWith(prefix),
  );
  const assets = [
    "Yurt-Playground-aarch64-apple-darwin.dmg",
    "Yurt-Playground-x86_64-apple-darwin.dmg",
    "Yurt-Playground-x86_64-unknown-linux-gnu.deb",
    "Yurt-Playground-aarch64-unknown-linux-gnu.deb",
    // The command line, mirrored into the same release from the pinned
    // yurt-packages release (artifacts/pins.json yurtCli).
    "yurt-aarch64-apple-darwin.tar.gz",
    "yurt-x86_64-apple-darwin.tar.gz",
    "yurt-x86_64-unknown-linux-gnu.deb",
    "yurt-aarch64-unknown-linux-gnu.deb",
  ];
  assertEquals(links.length, assets.length, `download links: ${links}`);
  for (const asset of assets) {
    assertEquals(links.includes(prefix + asset), true, asset);
    // The workflow packages under exactly that name and attaches it.
    assertStringIncludes(workflow, asset);
  }
  // A merge to main publishes the release the links resolve to.
  assertStringIncludes(workflow, "branches: [main]");
  assertStringIncludes(workflow, "gh release create");
});

Deno.test("the launcher tells the page the sandbox is native and relays /ws", async () => {
  // A stand-in host: what src/desktop_host.ts would have spawned.
  const upstream = Deno.serve(
    { port: 0, hostname: "127.0.0.1", onListen() {} },
    (req) => {
      // The host takes the launcher's token on every request.
      assertEquals(new URL(req.url).searchParams.get("token"), "deadbeef");
      const { socket, response } = Deno.upgradeWebSocket(req);
      socket.onmessage = (event) => socket.send(`echo:${event.data}`);
      return response;
    },
  );
  const addr = upstream.addr as Deno.NetAddr;
  const host = {
    url: `http://127.0.0.1:${addr.port}/`,
    token: "deadbeef",
    kernelPorts: [1, 2, 3, 4, 5] as [number, number, number, number, number],
    bootMs: 1234,
    stop() {},
  };
  const dist = await fakeDist();
  const server = startDesktopServer(dist, host);
  try {
    const info = await (await fetch(`${server.url}desktop.json`)).json();
    assertEquals(info, {
      native: true,
      kernelPorts: [1, 2, 3, 4, 5],
      bootMs: 1234,
    });
    const ws = new WebSocket(`${server.url.replace("http", "ws")}ws/tty`);
    const reply = await new Promise<string>((resolve, reject) => {
      ws.onopen = () => ws.send("hi");
      ws.onmessage = (event) => resolve(String(event.data));
      ws.onerror = () => reject(new Error("proxied socket failed"));
      ws.onclose = (event) =>
        reject(
          new Error(`proxied socket closed: ${event.code} ${event.reason}`),
        );
    });
    assertEquals(reply, "echo:hi");
    ws.close();
    await new Promise((resolve) => (ws.onclose = resolve));
  } finally {
    await server.shutdown();
    await upstream.shutdown();
    await Deno.remove(dist, { recursive: true });
  }
});

Deno.test("desktopInfo reads as 'not the app' wherever the launcher is absent", async () => {
  // Cloudflare Pages answers an unknown path with the home page and a 200.
  const pagesLike = () =>
    Promise.resolve(
      new Response("<!doctype html><title>Yurt playground</title>", {
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
    );
  assertEquals(await desktopInfo(pagesLike), undefined);
  const notFound = () => Promise.resolve(new Response("nope", { status: 404 }));
  assertEquals(await desktopInfo(notFound), undefined);
  const offline = () => Promise.reject(new Error("network"));
  assertEquals(await desktopInfo(offline), undefined);
  const app = () =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          native: true,
          kernelPorts: [1, 2, 3, 4, 5],
          bootMs: 7,
        }),
        { headers: { "content-type": "application/json; charset=utf-8" } },
      ),
    );
  assertEquals((await desktopInfo(app))?.kernelPorts, [1, 2, 3, 4, 5]);
});

Deno.test("the launcher refuses other origins on the sandbox endpoints", async () => {
  const host = {
    url: "http://127.0.0.1:1/",
    token: "deadbeef",
    kernelPorts: [1, 2, 3, 4, 5] as [number, number, number, number, number],
    bootMs: 1,
    stop() {},
  };
  const dist = await fakeDist();
  const server = startDesktopServer(dist, host);
  try {
    for (const path of ["desktop.json", "ws/tty", "ws/port/1"]) {
      const res = await fetch(`${server.url}${path}`, {
        headers: { origin: "http://evil.example" },
      });
      assertEquals(res.status, 403, path);
      await res.body?.cancel();
    }
    // Its own origin, and no origin (the acceptance's plain fetch), are fine.
    const own = await fetch(`${server.url}desktop.json`, {
      headers: { origin: server.url.replace(/\/$/, "") },
    });
    assertEquals(own.status, 200);
    await own.body?.cancel();
  } finally {
    await server.shutdown();
    await Deno.remove(dist, { recursive: true });
  }
});

Deno.test("desktop server applies Pages' directory rule to the Jupyter apps", async () => {
  // Notebook 7 opens "New Console for Notebook" at `consoles?path=…` — no
  // index.html, no trailing slash — and its assets are relative, so the
  // directory must redirect to its slash form (query kept) and that form
  // must serve the index, exactly as Cloudflare Pages does (#73).
  const dist = await fakeDist();
  try {
    const handle = handleDistRequest(dist);
    const bare = await handle(
      new Request("http://desktop/jupyter/lab?path=welcome.ipynb"),
    );
    assertEquals(bare.status, 308);
    assertEquals(
      bare.headers.get("location"),
      "/jupyter/lab/?path=welcome.ipynb",
    );
    assertIsolated(bare);
    await bare.body?.cancel();
    const slash = await handle(
      new Request("http://desktop/jupyter/lab/?path=welcome.ipynb"),
    );
    assertEquals(slash.status, 200);
    assertEquals(slash.headers.get("content-type"), "text/html; charset=utf-8");
    assertStringIncludes(
      slash.headers.get("Content-Security-Policy")!,
      "'unsafe-eval'",
    );
    assertStringIncludes(await slash.text(), "window.lab = 1");
  } finally {
    await Deno.remove(dist, { recursive: true });
  }
});
