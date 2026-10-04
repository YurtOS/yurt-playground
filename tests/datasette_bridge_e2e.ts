import { assertEquals, assertStringIncludes } from "@std/assert";
import { chromium } from "playwright";
import { ISOLATION_HEADERS } from "../src/serve.ts";
import { bundleFixture } from "./datasette_harness.ts";
const worker = await bundleFixture("src/datasette_service_worker.ts");
const pageBundle = await bundleFixture("src/datasette_page.ts");
const uiJs = String.raw`
import {mountDatasette} from '/page.js';
const session='33333333-3333-4333-8333-333333333333',prefix='/apps/datasette/'+session+'/';
class Coordinator extends EventTarget {
  emit(data){this.dispatchEvent(new MessageEvent('message',{data}));}
  postMessage(m){
    if(m.type==='datasette-start') this.emit({type:'datasette-state',app:'datasette',snapshot:{state:'running',session,prefix}});
    if(m.type==='datasette-stop'||m.type==='datasette-reset') this.emit({type:'datasette-state',app:'datasette',snapshot:{state:'stopped'}});
    if(m.type==='datasette-http') {
      let body='<html><body><h1>Guest UI</h1><a href="'+prefix+'orders.csv">CSV</a></body></html>',headers=[['content-type','text/html']];
      if(m.path.includes('orders.json')) {body='[{"product":"Mug","revenue_cents":8400},{"product":"Notebook","revenue_cents":4000},{"product":"Pen","revenue_cents":2000}]';headers=[['content-type','application/json']];}
      if(m.path.includes('orders.csv')) {body='product,revenue_cents\r\nMug,8400\r\nNotebook,4000\r\nPen,2000\r\n';headers=[['content-type','text/csv'],['content-disposition','attachment; filename="revenue.csv"']];}
      const send=()=>this.emit({type:'datasette-response',session,requestId:m.requestId,status:200,headers,body:new TextEncoder().encode(body).buffer});
      if(m.path.endsWith('/slow')) setTimeout(send,8000);else send();
    }
  }
}
const coordinator=new Coordinator();window.coordinator=coordinator;
mountDatasette(document.getElementById('demo'),coordinator,true);
mountDatasette(document.getElementById('desktop'),coordinator,false);
window.qualify=()=>coordinator.emit({type:'datasette-qualification',hashes:['sha256-'+'A'.repeat(43)+'=']});
window.uiReady=true;
`;
const policy =
  "default-src 'self'; script-src 'self'; worker-src 'self'; frame-src 'self'; style-src 'self'; object-src 'none'";
const headers = { ...ISOLATION_HEADERS, "Content-Security-Policy": policy };
const ownerJs = `
const session = new URL(location.href).searchParams.get('session');
const prefix = '/apps/datasette/' + session + '/';
let registration;
async function bind(nonce=crypto.randomUUID()) {
  registration = await navigator.serviceWorker.register('/apps/datasette/service-worker.js',{scope:'/apps/datasette/'});
  const deadline=Date.now()+5000;
  while(!registration.active){if(Date.now()>deadline)throw new Error('activation timeout');await new Promise(r=>setTimeout(r,20));}
  const channel=new MessageChannel();
  const registered=new Promise((resolve,reject)=>{const t=setTimeout(()=>reject(new Error('handshake timeout')),5000);channel.port1.onmessage=e=>{
    const m=e.data;
    if(m.type==='datasette-registered'&&m.session===session&&m.nonce===nonce){clearTimeout(t);resolve();}
    if(m.type==='datasette-http'){
      const p=new URL(m.path,location.origin);
      let body='<html><head><title>Guest '+session+'</title></head><body><h1>'+session+'</h1><form action="'+prefix+'query"><input name="sql" value="SELECT 1"><button>Query</button></form><script src="'+prefix+'asset.js"></script></body></html>';
      let type='text/html';
      if(p.pathname.endsWith('/asset.js')){type='text/javascript';body='document.body.dataset.asset="loaded"';}
      if(p.pathname.endsWith('/json')){type='application/json';body='[{"ready":1}]';}
      channel.port1.postMessage({type:'datasette-response',session,requestId:m.requestId,status:200,headers:[['Content-Type',type]],body:new TextEncoder().encode(body).buffer});
    }
  };});
  channel.port1.start();registration.active.postMessage({type:'datasette-register',app:'datasette',session,prefix,nonce,hashes:['sha256-'+ 'A'.repeat(43)+'=']},[channel.port2]);
  await registered;
}
navigator.serviceWorker.addEventListener('message',e=>{if(e.data.type==='datasette-find-owner'&&e.data.session===session)bind(e.data.nonce).catch(console.error);});
window.bind=bind;
bind().then(()=>{const iframe=document.createElement('iframe');iframe.src=prefix;document.body.append(iframe);window.bound=true;}).catch(e=>{window.failure=String(e);});
`;
let networkGuestRequests = 0;
const server = Deno.serve({
  hostname: "127.0.0.1",
  port: 0,
  onListen: () => {},
}, (req) => {
  const path = new URL(req.url).pathname;
  if (path === "/apps/datasette/service-worker.js") {
    return new Response(worker, {
      headers: { ...headers, "Content-Type": "text/javascript" },
    });
  }
  if (path === "/page.js") {
    return new Response(pageBundle, {
      headers: { ...headers, "Content-Type": "text/javascript" },
    });
  }
  if (path === "/ui.js") {
    return new Response(uiJs, {
      headers: { ...headers, "Content-Type": "text/javascript" },
    });
  }
  if (path === "/owner.js") {
    return new Response(ownerJs, {
      headers: { ...headers, "Content-Type": "text/javascript" },
    });
  }
  if (path.startsWith("/apps/datasette/")) {
    networkGuestRequests++;
    return new Response("NETWORK FALLBACK", {
      headers: { ...ISOLATION_HEADERS, "Content-Type": "text/html" },
    });
  }
  return new Response(
    new URL(req.url).searchParams.has("ui")
      ? '<!doctype html><html><body><section id="demo"></section><section id="desktop"></section><script type="module" src="/ui.js"></script></body></html>'
      : '<!doctype html><html><body><script src="/owner.js"></script></body></html>',
    { headers: { ...headers, "Content-Type": "text/html" } },
  );
});
const address = server.addr as Deno.NetAddr;
const origin = `http://127.0.0.1:${address.port}`;
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext();
  context.setDefaultTimeout(15000);
  const first = "11111111-1111-4111-8111-111111111111",
    second = "22222222-2222-4222-8222-222222222222";
  const owner = await context.newPage();
  const other = await context.newPage();
  const violations: string[] = [];
  owner.on("console", (msg) => {
    if (msg.type() === "error" && !msg.text().includes("status of 403")) {
      violations.push(msg.text());
    }
  });
  await owner.goto(origin + "/?session=" + first);
  await owner.waitForFunction(() =>
    !!(window as unknown as { bound: boolean }).bound
  );
  await other.goto(origin + "/?session=" + second);
  await other.waitForFunction(() =>
    !!(window as unknown as { bound: boolean }).bound
  );
  await owner.frameLocator("iframe").locator("body[data-asset=loaded]")
    .waitFor();
  assertEquals(
    await owner.evaluate(() => navigator.serviceWorker.controller !== null),
    false,
  );
  assertEquals(await owner.evaluate(() => crossOriginIsolated), true);
  assertEquals(
    await owner.frameLocator("iframe").locator("h1").textContent(),
    first,
  );
  assertEquals(
    await other.frameLocator("iframe").locator("h1").textContent(),
    second,
  );
  await owner.frameLocator("iframe").getByRole("button", { name: "Query" })
    .click();
  await owner.waitForFunction(() =>
    document.querySelector("iframe")?.contentWindow?.location.pathname.endsWith(
      "/query",
    )
  );
  await owner.frameLocator("iframe").locator("body[data-asset=loaded]")
    .waitFor();
  const frame = owner.frames().find((f) =>
    f.url().includes("/apps/datasette/")
  )!;
  const result = await frame.evaluate(async () => {
    const post = await fetch(location.pathname, { method: "POST", body: "x" });
    const noReferrer = await fetch(location.pathname, {
      method: "POST",
      body: "x",
      referrerPolicy: "no-referrer",
    });
    const head = await fetch(location.pathname, { method: "HEAD" });
    return {
      post: post.status,
      allow: post.headers.get("allow"),
      noReferrer: noReferrer.status,
      head: head.status,
      length: (await head.arrayBuffer()).byteLength,
      coep: head.headers.get("cross-origin-embedder-policy"),
    };
  });
  assertEquals(result, {
    post: 200,
    allow: null,
    noReferrer: 403,
    head: 200,
    length: 0,
    coep: "require-corp",
  });
  assertEquals(networkGuestRequests, 0);
  assertEquals(
    await owner.evaluate(
      async (p) => (await fetch(p)).text(),
      `/apps/datasette/${first}/json`,
    ),
    "NETWORK FALLBACK",
  );
  assertEquals(networkGuestRequests, 1);
  const cdp = await context.newCDPSession(owner);
  let version: string | undefined;
  cdp.on("ServiceWorker.workerVersionUpdated", (event) => {
    for (const v of event.versions) {
      if (
        v.scriptURL.endsWith("/apps/datasette/service-worker.js") &&
        v.status === "activated"
      ) version = v.versionId;
    }
  });
  await cdp.send("ServiceWorker.enable");
  for (let i = 0; i < 50 && !version; i++) {
    await new Promise((r) => setTimeout(r, 20));
  }
  if (!version) throw new Error("worker version unavailable");
  await cdp.send("ServiceWorker.stopWorker", { versionId: version });
  assertStringIncludes(
    await frame.evaluate(async () =>
      await (await fetch(location.pathname)).text()
    ),
    first,
  );
  await owner.close();
  const detached = await context.newPage();
  const response = await detached.goto(origin + `/apps/datasette/${first}/`);
  assertEquals(response!.status(), 403);
  assertStringIncludes(
    await detached.locator("body").innerText(),
    "preview panel",
  );
  assertEquals(networkGuestRequests, 1);
  assertEquals(violations, []);
  await context.close();
  const uiContext = await browser.newContext({ acceptDownloads: true });
  uiContext.setDefaultTimeout(15000);
  const ui = await uiContext.newPage();
  ui.on("pageerror", (e) => console.error("UI:", e.message));
  await ui.goto(origin + "/?ui=1");
  await ui.waitForFunction(() =>
    !!(window as unknown as { uiReady: boolean }).uiReady
  );
  assertEquals(await ui.locator("#demo").isHidden(), true);
  await ui.evaluate(() => (window as unknown as { qualify(): void }).qualify());
  assertEquals(await ui.locator("#desktop").isHidden(), true);
  await ui.getByRole("button", { name: "Start Datasette" }).click();
  await ui.frameLocator("iframe").getByRole("heading", { name: "Guest UI" })
    .waitFor();
  await ui.evaluate(() => {
    (window as unknown as {
      coordinator: { emit(data: unknown): void };
    }).coordinator.emit({
      type: "datasette-state",
      app: "preview",
      snapshot: { state: "stopped" },
    });
  });
  assertEquals(await ui.locator("#demo iframe").count(), 1);
  assertEquals(
    await ui.locator("#demo [data-status]").textContent(),
    "running",
  );
  await ui.evaluate(() => {
    const original = ServiceWorker.prototype.postMessage;
    (window as unknown as { registrations: number }).registrations = 0;
    ServiceWorker.prototype.postMessage = function (
      message: unknown,
      transfer?: Transferable[] | StructuredSerializeOptions,
    ) {
      if ((message as { type: string }).type === "datasette-register") {
        (window as unknown as { registrations: number }).registrations++;
      }
      return original.call(this, message, {
        transfer: Array.isArray(transfer) ? transfer : transfer?.transfer ?? [],
      });
    };
  });
  const uiFrame = ui.frames().find((f) =>
    f.url().includes("/apps/datasette/")
  )!;
  const slow = await uiFrame.evaluate(async () => {
    const r = await fetch(new URL("slow", location.href));
    return { status: r.status, text: await r.text() };
  });
  assertEquals(slow.status, 200);
  assertStringIncludes(slow.text, "Guest UI");
  assertEquals(
    await ui.evaluate(() =>
      (window as unknown as { registrations: number }).registrations
    ),
    0,
  );
  const jsonPromise = ui.waitForEvent("download");
  await ui.getByRole("button", { name: "Download revenue JSON" }).click();
  const json = await jsonPromise;
  assertEquals(json.suggestedFilename(), "revenue-by-product.json");
  assertEquals(JSON.parse(await Deno.readTextFile((await json.path())!)), [
    { product: "Mug", revenue_cents: 8400 },
    { product: "Notebook", revenue_cents: 4000 },
    { product: "Pen", revenue_cents: 2000 },
  ]);
  const csvPromise = ui.waitForEvent("download");
  await ui.frameLocator("iframe").getByRole("link", {
    name: "CSV",
    exact: true,
  }).click();
  const csv = await csvPromise;
  assertEquals(
    await Deno.readTextFile((await csv.path())!),
    "product,revenue_cents\r\nMug,8400\r\nNotebook,4000\r\nPen,2000\r\n",
  );
  await ui.getByRole("button", { name: "Stop", exact: true }).click();
  assertEquals(await ui.locator("iframe").count(), 0);
  await ui.getByRole("button", { name: "Reset sample" }).click();
  await ui.getByRole("button", { name: "Start Datasette" }).click();
  await ui.frameLocator("iframe").getByRole("heading", { name: "Guest UI" })
    .waitFor();
  await uiContext.close();
  console.log(
    "Datasette scoped bridge: navigation, form, asset CSP, two owners, HEAD/POST, eviction recovery, missing owner PASS",
  );
} finally {
  await browser.close();
  await server.shutdown();
}
