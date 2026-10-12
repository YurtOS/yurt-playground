import { assertEquals, assertStringIncludes } from "@std/assert";
import { chromium, type Page } from "playwright";
import type { Execution, Yurt } from "../src/agent_api.ts";
import { quoted } from "../src/executions.ts";
import { ensureBundle } from "../scripts/serve.ts";
import { handlePlaygroundRequest, ISOLATION_HEADERS } from "../src/serve.ts";
import { resolvePlaygroundArtifacts } from "./ash_harness.ts";
import { watchCspViolations } from "./csp_watch.ts";

await resolvePlaygroundArtifacts(true);
await ensureBundle(Deno.env.get("YURT_KERNEL_ROOT"));
const server = Deno.serve(
  { hostname: "127.0.0.1", port: 0, onListen() {} },
  (req) => {
    const path = new URL(req.url).pathname;
    if (path === "/migration") {
      return new Response(
        "<!doctype html><title>Worker migration setup</title>",
        {
          headers: { ...ISOLATION_HEADERS, "content-type": "text/html" },
        },
      );
    }
    if (path === "/apps/datasette/legacy-sw.js") {
      return new Response(
        "self.addEventListener('install',()=>self.skipWaiting());",
        {
          headers: { ...ISOLATION_HEADERS, "content-type": "text/javascript" },
        },
      );
    }
    return handlePlaygroundRequest(req);
  },
);
const origin = `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`;
const profile = await Deno.makeTempDir({ prefix: "preview-e2e-" });
const context = await chromium.launchPersistentContext(profile, {
  headless: true,
});
context.setDefaultTimeout(300000);
const external: string[] = [], errors: string[] = [];
await context.route("**/*", (route) => {
  const url = new URL(route.request().url());
  if (url.protocol !== "blob:" && url.origin !== origin) {
    external.push(url.href);
    return route.abort();
  }
  return route.continue();
});
const page = await context.newPage();
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => {
  if (message.type() === "error" && !message.text().includes("status of 403")) {
    errors.push(message.text());
  }
});
const checkCsp = watchCspViolations(page);
async function command(page: Page, line: string) {
  const result = await page.evaluate(async (line) => {
    return await (window as unknown as { yurt: Yurt }).yurt.exec(line);
  }, line);
  assertEquals(
    "code" in result ? result.code : undefined,
    0,
    JSON.stringify(result),
  );
  return result.stdout;
}
const panel = page.locator("#preview");
const start = async (heading = "Yurt Preview") => {
  await panel.getByRole("button", { name: "Start preview", exact: true })
    .click();
  await page.waitForFunction(() => {
    const status = document.querySelector("#preview [data-status]")
      ?.textContent;
    return !!status && !["starting", "stopped"].includes(status);
  });
  assertEquals(
    await panel.locator("[data-status]").textContent(),
    "running",
    await panel.innerText(),
  );
  await page.frameLocator("#preview iframe").getByRole("heading", {
    name: heading,
    exact: true,
  }).waitFor();
  const frame = page.frames().find((frame) =>
    frame.url().includes("/apps/preview/")
  );
  if (!frame) throw new Error("Preview frame missing");
  await frame.getByRole("heading", { name: heading, exact: true })
    .waitFor();
  return frame;
};
try {
  await page.goto(origin + "/migration");
  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.register(
      "/apps/datasette/legacy-sw.js",
      { scope: "/apps/datasette/" },
    );
    if (!registration.active) {
      const worker = registration.installing ?? registration.waiting!;
      await new Promise<void>((resolve) =>
        worker.addEventListener("statechange", () => {
          if (worker.state === "activated") resolve();
        })
      );
    }
  });
  await page.goto(origin);
  await page.getByRole("button", { name: "Start the sandbox", exact: true })
    .click();
  // Match the playground acceptance precondition: the complete workspace is ready.
  await page.waitForFunction(() =>
    document.querySelector('[data-testid="notebook-status"]')?.textContent ===
      "ready" ||
    document.querySelector<HTMLElement>("#failed")?.hidden === false
  );
  assertEquals(
    await page.getByTestId("notebook-status").textContent(),
    "ready",
    await page.locator("#status").textContent() ?? "workspace boot failed",
  );
  console.log("Playground workspace ready");
  let frame = await start();
  let prefix = new URL(frame.url()).pathname;
  console.log("Preview guest started");
  const scopes = await page.evaluate(async () =>
    (await navigator.serviceWorker.getRegistrations()).map((r) =>
      new URL(r.scope).pathname
    )
  );
  assertEquals(scopes.includes("/apps/datasette/"), false);
  assertEquals(scopes.includes("/apps/"), true);
  await frame.locator("html[data-preview=ready]").waitFor();

  const fixtures = `from pathlib import Path
p=Path('/home/user/demos/preview/site')
p.joinpath('app.mjs').write_text('document.body.dataset.moduleLoaded="yes";')
p.joinpath('x.wasm').write_bytes(bytes.fromhex('0061736d01000000'))
for i in range(24): p.joinpath('burst-%d.js'%i).write_text('document.body.dataset.loaded=String(Number(document.body.dataset.loaded||0)+1);')
p.joinpath('burst.html').write_text('<!doctype html><body>'+''.join('<script src="burst-%d.js"></script>'%i for i in range(24))+'</body>')
`;
  await command(page, "python3 -c " + quoted(fixtures));
  const types = await frame.evaluate(async () => {
    const module = await fetch("app.mjs");
    const moduleType = module.headers.get("content-type");
    await module.arrayBuffer();
    await import(new URL("app.mjs", location.href).href);
    const wasm = await fetch("x.wasm");
    const wasmType = wasm.headers.get("content-type");
    const bytes = [...new Uint8Array(await wasm.arrayBuffer())];
    return {
      moduleType,
      wasmType,
      bytes,
      loaded: document.body.dataset.moduleLoaded,
    };
  });
  assertEquals(types.moduleType?.startsWith("text/javascript"), true);
  assertEquals(types.wasmType, "application/wasm");
  assertEquals(types.bytes, [0, 97, 115, 109, 1, 0, 0, 0]);
  assertEquals(types.loaded, "yes");
  await frame.goto(origin + prefix + "burst.html");
  await frame.locator('body[data-loaded="24"]').waitFor({ state: "attached" });
  await frame.goto(origin + prefix + "form");
  await frame.getByLabel("Name").fill("Ada");
  await frame.getByRole("button", { name: "Save", exact: true }).click();
  await frame.getByText("Hello, Ada!", { exact: true }).waitFor();
  assertEquals(new URL(frame.url()).pathname, prefix);
  await frame.goto(origin + prefix);
  await frame.getByText("Hello, Ada!", { exact: true }).waitFor();
  assertEquals(
    await frame.evaluate(() => document.cookie.includes("yurt_name")),
    false,
  );
  assertEquals(
    await frame.evaluate(async () => {
      const response = await fetch("form", {
        method: "POST",
        body: "x",
        referrerPolicy: "no-referrer",
      });
      await response.arrayBuffer();
      return response.status;
    }),
    403,
  );
  await command(
    page,
    "printf '<h1>edited</h1>' > /home/user/demos/preview/site/index.html",
  );
  await frame.goto(origin + prefix);
  await frame.getByRole("heading", { name: "edited", exact: true }).waitFor();
  assertStringIncludes(
    await command(page, "tail -n 5 /home/user/demos/preview/server.log"),
    "GET",
  );
  console.log("Preview MIME, burst, form/cookies and terminal edit passed");

  await panel.getByRole("button", { name: "Stop", exact: true }).click();
  await panel.locator('[data-status]:text-is("stopped")').waitFor();
  await panel.getByRole("button", { name: "Start preview", exact: true })
    .click();
  await page.frameLocator("#preview iframe").getByRole("heading", {
    name: "edited",
    exact: true,
  }).waitFor();
  await panel.getByRole("button", { name: "Reset", exact: true }).click();
  await panel.locator('[data-status]:text-is("stopped")').waitFor();
  frame = await start();
  prefix = new URL(frame.url()).pathname;
  console.log("Preview reset restored defaults");
  assertEquals(
    await frame.getByText("Hello, Ada!", { exact: true }).count(),
    0,
  );
  await frame.locator("html[data-preview=ready]").waitFor();
  const detached = await context.newPage();
  await detached.goto(origin + prefix);
  await detached.getByText(/Open this page inside the preview panel/).waitFor();
  await detached.close();
  await panel.getByRole("button", { name: "Stop", exact: true }).click();
  await panel.locator('[data-status]:text-is("stopped")').waitFor();

  const busy =
    "from http.server import HTTPServer,SimpleHTTPRequestHandler; from pathlib import Path; s=HTTPServer(('127.0.0.1',8002),SimpleHTTPRequestHandler); Path('/tmp/preview-port-ready').write_text('ready'); s.serve_forever()";
  await page.evaluate(async (line) => {
    const host = window as unknown as { yurt: Yurt; previewBusy: Execution };
    host.previewBusy = await host.yurt.spawn(line, { timeoutMs: 300000 });
  }, "exec python3 -c " + quoted(busy));
  try {
    await command(
      page,
      "i=0; while [ ! -s /tmp/preview-port-ready ] && [ $i -lt 120 ]; do sleep 1; i=$((i+1)); done; test -s /tmp/preview-port-ready",
    );
    await panel.getByRole("button", { name: "Start preview", exact: true })
      .click();
    await panel.locator("[data-status]").getByText(/in use/).waitFor();
    assertStringIncludes(
      await command(page, "printf terminal-usable"),
      "terminal-usable",
    );
  } finally {
    await page.evaluate(async () => {
      const process =
        (window as unknown as { previewBusy: Execution }).previewBusy;
      await process.kill();
      await process.wait();
    });
  }
  checkCsp();
  assertEquals(external, []);
  assertEquals(errors, []);
  console.log(
    "Real preview guest: MIME, burst, cookie form, edits, lifecycle, occupied port, top-level refusal and migration PASS",
  );
} catch (error) {
  console.error(
    "Preview diagnostic:",
    await panel.innerText().catch(() => "panel unavailable"),
  );
  console.error(
    "Workspace diagnostic:",
    await page.locator("#status").textContent().catch(() => "unavailable"),
    errors,
  );
  throw error;
} finally {
  await context.close();
  await server.shutdown();
  await Deno.remove(profile, { recursive: true });
}
