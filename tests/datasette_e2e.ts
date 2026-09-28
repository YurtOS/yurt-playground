import { assertEquals } from "@std/assert";
import { chromium } from "playwright";
import { loadPins } from "../src/pins.ts";
import { quoted } from "../src/executions.ts";
import { DATASETTE_QUERY } from "../src/datasette.ts";
import { ensureBundle } from "../scripts/serve.ts";
import { startPlaygroundServer } from "../src/serve.ts";
const pins = await loadPins(
  new URL("../artifacts/pins.json", import.meta.url).pathname,
);
if (!pins.datasette) {
  throw new Error(
    "Datasette acceptance requires a published qualified image/kernel pair",
  );
}
await ensureBundle(Deno.env.get("YURT_KERNEL_ROOT"));
const server = startPlaygroundServer(0),
  browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ acceptDownloads: true });
  context.setDefaultTimeout(300000);
  const page = await context.newPage();
  await page.goto(server.url);
  await page.getByRole("button", { name: "Start the sandbox", exact: true })
    .click();
  await page.getByRole("button", { name: "Start Datasette", exact: true })
    .click();
  await page.frameLocator("#datasette iframe").locator("body").waitFor();
  const frame = page.frames().find((f) =>
    f.url().includes("/apps/datasette/")
  )!;
  const prefix = new URL(frame.url()).pathname;
  await frame.goto(server.url + prefix + "orders/orders");
  await frame.locator("table").waitFor();
  await frame.goto(
    server.url + prefix + "orders?sql=" + encodeURIComponent(DATASETTE_QUERY),
  );
  await frame.locator("textarea[name=sql]").fill(DATASETTE_QUERY);
  await frame.locator("form").filter({
    has: frame.locator("textarea[name=sql]"),
  }).locator("[type=submit]").first().click();
  await frame.getByText("8400", { exact: true }).waitFor();
  const promise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download revenue JSON", exact: true })
    .click();
  const download = await promise;
  assertEquals(JSON.parse(await Deno.readTextFile((await download.path())!)), [
    { product: "Mug", revenue_cents: 8400 },
    { product: "Notebook", revenue_cents: 4000 },
    { product: "Pen", revenue_cents: 2000 },
  ]);
  const csvPromise = page.waitForEvent("download");
  await frame.evaluate(
    (url) => {
      const link = document.createElement("a");
      link.href = url;
      link.textContent = "CSV export";
      document.body.append(link);
      link.click();
      link.remove();
    },
    server.url + prefix + "orders.csv?sql=" +
      encodeURIComponent(DATASETTE_QUERY),
  );
  const csv = await csvPromise;
  assertEquals(
    await Deno.readTextFile((await csv.path())!),
    "product,revenue_cents\r\nMug,8400\r\nNotebook,4000\r\nPen,2000\r\n",
  );
  const mutation = await page.evaluate(
    async (command) => {
      const yurt = (window as unknown as {
        yurt: {
          exec(cmd: string): Promise<{ code: number; stderr: string }>;
        };
      }).yurt;
      return await yurt.exec(command);
    },
    "python3 -c " +
      quoted(
        "import sqlite3; d=sqlite3.connect('/home/user/demos/datasette/orders.db'); d.execute('INSERT INTO orders VALUES (?,?,?,?,?)',(13,'2026-01-07','Pen',10,100)); d.commit(); d.close()",
      ),
  );
  assertEquals(mutation.code, 0, mutation.stderr);
  await frame.goto(
    server.url + prefix + "orders?sql=" + encodeURIComponent(DATASETTE_QUERY),
  );
  await frame.getByText("3000", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await page.getByRole("button", { name: "Start Datasette", exact: true })
    .click();
  const restarted = page.frames().find((f) =>
    f.url().includes("/apps/datasette/")
  );
  await page.frameLocator("#datasette iframe").locator("body").waitFor();
  const next = restarted ??
    page.frames().find((f) => f.url().includes("/apps/datasette/"))!;
  const nextPrefix = new URL(next.url()).pathname;
  await next.goto(
    server.url + nextPrefix + "orders?sql=" +
      encodeURIComponent(DATASETTE_QUERY),
  );
  await next.getByText("3000", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Reset sample", exact: true }).click();
  await page.getByRole("button", { name: "Start Datasette", exact: true })
    .click();
  await page.frameLocator("#datasette iframe").locator("body").waitFor();
  const reset = page.frames().find((f) =>
    f.url().includes("/apps/datasette/")
  )!;
  await reset.goto(
    server.url + new URL(reset.url()).pathname + "orders?sql=" +
      encodeURIComponent(DATASETTE_QUERY),
  );
  await reset.getByText("2000", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await context.close();
  console.log(
    "Qualified upstream Datasette: browsing, SQL, exact CSV/JSON, terminal mutation, stop/start and reset PASS",
  );
} finally {
  await browser.close();
  await server.shutdown();
}
