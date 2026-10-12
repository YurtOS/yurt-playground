import { assertEquals, assertStringIncludes } from "@std/assert";
import { previewSpec } from "../src/preview.ts";
import type { GuestAppContext } from "../src/guest_app.ts";

const PREFIX = "/apps/preview/11111111-1111-4111-8111-111111111111/";
const decoder = new TextDecoder();

Deno.test("preview spec installs defaults once and reset restores them", async () => {
  const installed = new Map<string, string>();
  const assets: string[] = [];
  const finite: string[] = [];
  const ctx: GuestAppContext = {
    asset: (name) => {
      assets.push(name);
      return Promise.resolve(new TextEncoder().encode(name));
    },
    finite: (line, stdin) => {
      finite.push(line);
      const target = line.match(/cat > '([^']+)'/)?.[1];
      if (
        target && stdin && (!line.includes("[ ! -e") || !installed.has(target))
      ) {
        installed.set(target, decoder.decode(stdin));
      }
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    },
  };
  await previewSpec.prepare(ctx);
  assertEquals(assets, [
    "preview_server.py",
    "preview_index.html",
    "preview_app.js",
  ]);
  assertEquals(
    installed.get(previewSpec.dir + "/preview_server.py"),
    "preview_server.py",
  );
  assertEquals(
    installed.get(previewSpec.dir + "/site/index.html"),
    "preview_index.html",
  );
  assertEquals(
    installed.get(previewSpec.dir + "/site/app.js"),
    "preview_app.js",
  );
  const index = await Deno.readTextFile(
    new URL("../public/demo/preview_index.html", import.meta.url),
  );
  assertStringIncludes(index, '<script src="app.js"></script>');
  await Deno.stat(new URL("../public/demo/preview_app.js", import.meta.url));
  assertEquals(finite.filter((line) => line.includes("[ ! -e")).length, 2);
  installed.set(previewSpec.dir + "/site/index.html", "edited index");
  installed.set(previewSpec.dir + "/site/app.js", "edited script");
  await previewSpec.prepare(ctx);
  assertEquals(
    installed.get(previewSpec.dir + "/site/index.html"),
    "edited index",
  );
  assertEquals(
    installed.get(previewSpec.dir + "/site/app.js"),
    "edited script",
  );
  await previewSpec.reset(ctx);
  assertEquals(
    installed.get(previewSpec.dir + "/site/index.html"),
    "preview_index.html",
  );
  assertEquals(
    installed.get(previewSpec.dir + "/site/app.js"),
    "preview_app.js",
  );
});

Deno.test("preview spec uses its own port, prefix, and exact readiness marker", () => {
  assertEquals(previewSpec.id, "preview");
  assertEquals(previewSpec.readyPath(PREFIX), PREFIX + "__ready");
  const line = previewSpec.spawnLine(PREFIX, 8002);
  assertStringIncludes(line, "8002");
  assertStringIncludes(line, `'${PREFIX}'`);
  const reply = (status: number, body: string) => ({
    status,
    headers: [] as [string, string][],
    body: new TextEncoder().encode(body).buffer,
  });
  assertEquals(previewSpec.isReady(reply(200, "yurt-preview-ready")), true);
  assertEquals(previewSpec.isReady(reply(200, "different")), false);
  assertEquals(previewSpec.isReady(reply(503, "yurt-preview-ready")), false);
});
