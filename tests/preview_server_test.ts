import { assertEquals, assertStringIncludes } from "@std/assert";

const PREFIX = "/apps/preview/11111111-1111-4111-8111-111111111111/";

Deno.test("preview server serves prefixed static files and a cookie-backed form", async () => {
  try {
    await new Deno.Command("python3", { args: ["--version"] }).output();
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      console.log("SKIP: python3 is unavailable");
      return;
    }
    throw error;
  }
  const temp = await Deno.makeTempDir();
  const site = temp + "/site";
  await Deno.mkdir(site);
  await Deno.writeTextFile(
    site + "/index.html",
    '<h1>hi</h1><!--GREETING--><script src="app.js"></script>',
  );
  await Deno.writeTextFile(site + "/app.mjs", "export {};");
  await Deno.writeFile(site + "/x.wasm", new Uint8Array([0, 97, 115, 109]));
  await Deno.writeTextFile(temp + "/outside.txt", "secret");
  await Deno.symlink(temp + "/outside.txt", site + "/outside.txt");
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  listener.close();
  const server = new Deno.Command("python3", {
    args: [
      new URL("../public/demo/preview_server.py", import.meta.url).pathname,
      String(port),
      PREFIX,
      site,
    ],
    stdout: "piped",
    stderr: "null",
  }).spawn();
  const logs = new Response(server.stdout).text();
  const base = `http://127.0.0.1:${port}${PREFIX}`;
  try {
    let ready = false;
    for (let attempt = 0; attempt < 50; attempt++) {
      try {
        const response = await fetch(base + "__ready");
        ready = response.status === 200;
        await response.arrayBuffer();
        if (ready) break;
      } catch { /* still starting */ }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assertEquals(ready, true);
    assertEquals(
      await (await fetch(base + "__ready")).text(),
      "yurt-preview-ready",
    );
    const module = await fetch(base + "app.mjs");
    assertEquals(
      module.headers.get("content-type")?.startsWith("text/javascript"),
      true,
    );
    await module.arrayBuffer();
    const wasm = await fetch(base + "x.wasm");
    assertEquals(wasm.headers.get("content-type"), "application/wasm");
    await wasm.arrayBuffer();
    const traversal = await fetch(base + "..%2f..%2fetc/passwd");
    assertEquals(traversal.status, 404);
    await traversal.arrayBuffer();
    const outside = await fetch(base + "outside.txt");
    assertEquals(outside.status, 404);
    await outside.arrayBuffer();
    const form = await fetch(base + "form");
    const csrfCookie = form.headers.get("set-cookie")!.split(";")[0];
    const html = await form.text();
    const token = html.match(/name="csrf" value="([^"]+)"/)?.[1];
    assertEquals(csrfCookie, "yurt_csrf=" + token);
    assertStringIncludes(html, `action="${PREFIX}form"`);
    const post = await fetch(base + "form", {
      method: "POST",
      redirect: "manual",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: csrfCookie,
      },
      body: "name=Ada&csrf=" + token,
    });
    assertEquals(post.status, 303);
    assertEquals(post.headers.get("location"), PREFIX);
    assertStringIncludes(post.headers.get("set-cookie") ?? "", "yurt_name=Ada");
    await post.arrayBuffer();
    for (
      const [cookie, csrf] of [["", token], [csrfCookie, "wrong"]] as const
    ) {
      const denied = await fetch(base + "form", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie,
        },
        body: "name=Ada&csrf=" + csrf,
      });
      assertEquals(denied.status, 403);
      await denied.arrayBuffer();
    }
    const index = await fetch(base, { headers: { cookie: "yurt_name=Ada" } });
    assertStringIncludes(await index.text(), "Ada");
  } finally {
    server.kill("SIGTERM");
    await server.status;
    const output = await logs;
    assertStringIncludes(output, `GET ${PREFIX}__ready 200`);
    assertStringIncludes(output, `POST ${PREFIX}form 303`);
    await Deno.remove(temp, { recursive: true });
  }
});
