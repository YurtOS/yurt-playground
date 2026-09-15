import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "node:path";
import { handleDistRequest } from "../src/desktop.ts";
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
      const res = await handle(new Request(`http://desktop${path}`));
      assertEquals(res.status, 404, path);
      assertIsolated(res);
      await res.body?.cancel();
    }
  } finally {
    await Deno.remove(dist, { recursive: true });
  }
});

Deno.test("desktop build ships the binary with dist/ in the app bundle", async () => {
  const script = await Deno.readTextFile(
    new URL("../scripts/build-desktop.sh", import.meta.url),
  );
  for (
    const value of [
      "deno compile",
      "scripts/desktop.ts",
      "--allow-run=open",
      "Info.plist",
      "Contents/Resources/dist",
    ]
  ) {
    assertStringIncludes(script, value);
  }
});
