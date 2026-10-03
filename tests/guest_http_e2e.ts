import { assertEquals, assertStringIncludes } from "@std/assert";
import { chromium } from "playwright";
import { ensureBundle } from "../scripts/serve.ts";
import { handlePlaygroundRequest, ISOLATION_HEADERS } from "../src/serve.ts";
import { documentPolicy } from "../src/csp.ts";
import { bundleFixture } from "./datasette_harness.ts";
await ensureBundle(Deno.env.get("YURT_KERNEL_ROOT"));
const worker = await bundleFixture("tests/fixtures/guest_http_worker.ts", true);
const page = await bundleFixture("src/datasette_page.ts");
const factory = await bundleFixture("src/page_worker_bridge.ts");
const entry = `import {mountDatasette} from '/fixture-page.js';
import {attachGuestWorkerFactory} from '/fixture-factory.js';
const worker=new Worker('/fixture-worker.js');attachGuestWorkerFactory(worker);
window.fixtureWorker=worker;window.fixtureState='booting';
worker.addEventListener('message',e=>{if(e.data.type==='test-error')window.fixtureError=e.data.message;if(e.data.type==='datasette-state')window.fixtureState=e.data.snapshot.state;if(e.data.type==='edited')window.edited=true;if(e.data.type==='log')window.liveLog=e.data.text;if(e.data.type==='progress')document.getElementById('progress').textContent=e.data.text;});
mountDatasette(document.getElementById('demo'),worker,true);worker.postMessage({type:'boot'});`;
const server = Deno.serve({
  hostname: "127.0.0.1",
  port: 0,
  onListen: () => {},
}, (req) => {
  const path = new URL(req.url).pathname;
  const bytes = path === "/fixture-worker.js"
    ? worker
    : path === "/fixture-page.js"
    ? page
    : path === "/fixture-factory.js"
    ? factory
    : path === "/fixture-entry.js"
    ? entry
    : undefined;
  if (bytes !== undefined) {
    return new Response(bytes, {
      headers: { ...ISOLATION_HEADERS, "content-type": "text/javascript" },
    });
  }
  if (path === "/") {
    return new Response(
      '<!doctype html><html><body><p id="progress"></p><section id="demo"></section><script type="module" src="/fixture-entry.js"></script></body></html>',
      {
        headers: {
          ...ISOLATION_HEADERS,
          "content-type": "text/html",
          "Content-Security-Policy": documentPolicy("/", []),
        },
      },
    );
  }
  return handlePlaygroundRequest(req);
});
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext();
  context.setDefaultTimeout(240000);
  const owner = await context.newPage();
  owner.on("pageerror", (e) => console.error(e.message));
  await owner.goto(`http://127.0.0.1:${(server.addr as Deno.NetAddr).port}/`);
  await owner.getByRole("button", { name: "Start Datasette" }).waitFor();
  await owner.getByRole("button", { name: "Start Datasette" }).click();
  await owner.frameLocator("iframe").getByRole("heading", { name: "original" })
    .waitFor();
  await owner.frameLocator("iframe").locator("body[data-asset=loaded]")
    .waitFor();
  assertEquals(
    await owner.evaluate(() => navigator.serviceWorker.controller !== null),
    false,
  );
  await owner.evaluate(() =>
    (window as unknown as { fixtureWorker: Worker }).fixtureWorker.postMessage({
      type: "test-edit",
    })
  );
  await owner.waitForFunction(() =>
    (window as unknown as { edited: boolean }).edited
  );
  const frame = owner.frames().find((f) =>
    f.url().includes("/apps/datasette/")
  )!;
  await frame.goto(frame.url());
  await frame.getByRole("heading", { name: "changed" }).waitFor();
  await owner.evaluate(() =>
    (window as unknown as { fixtureWorker: Worker }).fixtureWorker.postMessage({
      type: "test-log",
    })
  );
  await owner.waitForFunction(() =>
    (window as unknown as { liveLog?: string }).liveLog !== undefined
  );
  assertStringIncludes(
    await owner.evaluate(() =>
      (window as unknown as { liveLog: string }).liveLog
    ),
    "GET /apps/datasette/",
  );
  // A resident must survive the execution registry's ordinary 120-second cap.
  await owner.waitForTimeout(121000);
  await frame.goto(frame.url());
  await frame.getByRole("heading", { name: "changed" }).waitFor();
  await owner.getByRole("button", { name: "Stop", exact: true }).click();
  await owner.waitForFunction(() =>
    (window as unknown as { fixtureState: string }).fixtureState === "stopped"
  );
  await owner.getByRole("button", { name: "Start Datasette" }).click();
  await owner.frameLocator("iframe").getByRole("heading", { name: "changed" })
    .waitFor();
  await owner.getByRole("button", { name: "Stop", exact: true }).click();
  await owner.waitForFunction(() =>
    (window as unknown as { fixtureState: string }).fixtureState === "stopped"
  );
  assertEquals(
    await owner.evaluate(() =>
      (window as unknown as { fixtureError?: string }).fixtureError
    ),
    undefined,
  );
  await context.close();
  console.log(
    "Real guest HTTP preview: assets, file edit, >120s residence, stop/restart port reuse PASS",
  );
} finally {
  await browser.close();
  await server.shutdown();
}
