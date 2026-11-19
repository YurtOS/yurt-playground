/**
 * The in-tab sandbox's network through the relay (#380), end to end in
 * Chrome: a local relay (relay/deno.ts) on this machine, the page told
 * about it as config/network.json would, Turnstile with Cloudflare's
 * always-pass test keys, and the guest's own curl and pip reaching PyPI
 * through it. Needs the internet, so it is not a CI scene:
 *
 *   deno run --allow-all tests/network_e2e.ts
 */
import type { Browser, Page } from "playwright";
import {
  runNewCell,
  waitForKernelIdle,
  waitForLastOutput,
} from "./jupyterlite_e2e.ts";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launchBrowser } from "../scripts/browser.ts";
import { ensureBundle } from "../scripts/serve.ts";
import { handlePlaygroundRequest } from "../src/serve.ts";
import { withRelay } from "../src/csp.ts";
import {
  NETWORK_CONFIG_PATH,
  TURNSTILE_ORIGIN,
} from "../src/network_config.ts";
import {
  startDenoRelay,
  TURNSTILE_TEST_SECRET,
  TURNSTILE_TEST_SITE_KEY,
} from "../relay/deno.ts";
import { watchCspViolations } from "./csp_watch.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

type Exec = { code: number | null; stdout: string; stderr: string };

function exec(page: Page, cmd: string, timeoutMs = 120_000): Promise<Exec> {
  return page.evaluate(
    ([cmd, timeoutMs]) =>
      (globalThis as unknown as {
        yurt: { exec(cmd: string, o: { timeoutMs: number }): Promise<Exec> };
      }).yurt.exec(cmd, { timeoutMs }),
    [cmd, timeoutMs] as const,
  );
}

function expect(what: string, ok: boolean, got: unknown): void {
  if (!ok) throw new Error(`network e2e: ${what}; got ${JSON.stringify(got)}`);
  console.log(`ok: ${what}`);
}

/** The page's server, with config/network.json naming `relay()` and every
 * policy letting the page reach it: what a deployed site with a relay
 * configured serves. */
function serveWithRelay(relay: () => string) {
  const server = Deno.serve(
    { port: 0, hostname: "127.0.0.1", onListen: () => {} },
    async (request) => {
      const url = new URL(request.url);
      if (url.pathname === `/${NETWORK_CONFIG_PATH}`) {
        return Response.json({
          relay: relay(),
          turnstileSiteKey: TURNSTILE_TEST_SITE_KEY,
        });
      }
      const response = await handlePlaygroundRequest(request);
      const policy = response.headers.get("Content-Security-Policy");
      if (policy === null) return response;
      const headers = new Headers(response.headers);
      headers.set("Content-Security-Policy", withRelay(policy, relay()));
      return new Response(response.body, { status: response.status, headers });
    },
  );
  const addr = server.addr as Deno.NetAddr;
  return { url: `http://127.0.0.1:${addr.port}`, server };
}

/** The Notebook page's own sandbox (#384): the network is off there too,
 * its panel turns it on, and a cell's `pip install` and `urllib` reach
 * PyPI through the relay. */
async function notebookHasTheNetwork(
  browser: Browser,
  url: string,
): Promise<void> {
  const context = await browser.newContext();
  const page = await context.newPage();
  const checkCsp = watchCspViolations(page);
  await page.goto(`${url}/jupyter/notebooks/index.html?path=welcome.ipynb`, {
    waitUntil: "load",
  });
  await page.locator(".jp-Notebook").first().waitFor({ timeout: 60_000 });
  await waitForKernelIdle(page, 480_000);
  const toggle = page.getByTestId("network-toggle");
  expect(
    "notebook: the network starts off",
    await toggle.getAttribute("aria-pressed") === "false",
    await toggle.textContent(),
  );
  await page.locator(".jp-Cell").last().click();
  const probe =
    "import urllib.request\ntry:\n    print('status', urllib.request.urlopen('https://pypi.org/simple/', timeout=60).status)\nexcept Exception as e:\n    print('failed', type(e).__name__)";
  await runNewCell(page, probe);
  await waitForLastOutput(page, "failed", 120_000);
  console.log("ok: notebook: off, urllib cannot reach PyPI");
  await toggle.click();
  await page.getByTestId("network-note").waitFor({ state: "visible" });
  // Back to the notebook: the keys below go to the focused element.
  await page.locator(".jp-Cell").last().click();
  await runNewCell(page, probe);
  await waitForLastOutput(page, "status 200", 180_000);
  console.log("ok: notebook: on, urllib.request.urlopen(PyPI) is 200");
  await runNewCell(page, "!pip install --no-cache-dir requests 2>&1 | tail -1");
  await waitForLastOutput(page, "Successfully installed", 300_000);
  // Into ~/.local, which the running kernel's sys.path took without (it
  // did not exist yet): a new Python finds it, as after a kernel restart.
  await runNewCell(
    page,
    "!python3 -c \"import requests; print('requests', requests.__version__)\"",
  );
  await waitForLastOutput(page, "requests 2.", 120_000);
  const output = await page.locator(".jp-OutputArea-output").last()
    .textContent();
  console.log(output);
  console.log("ok: notebook: !pip install requests");
  checkCsp();
  await context.close();
}

if (import.meta.main) {
  await ensureBundle(
    Deno.env.get("YURT_KERNEL_ROOT") ?? join(repoRoot, "../yurtos-kernel"),
  );
  let relayUrl = "";
  let turnstileWaitMs = 8_000;
  const site = serveWithRelay(() => relayUrl);
  const relay = startDenoRelay({
    secret: crypto.randomUUID(),
    allowedOrigins: [site.url],
    // Cloudflare's always-pass test keys: the real siteverify, no challenge.
    turnstileSecret: TURNSTILE_TEST_SECRET,
    // The first check takes as long as a managed challenge may (#380: the
    // first lookup after turning the network on failed in production).
    beforeVerify: () => new Promise((r) => setTimeout(r, turnstileWaitMs)),
  });
  relayUrl = relay.url;
  const browser = await launchBrowser();
  try {
    const page = await (await browser.newContext()).newPage();
    const checkCsp = watchCspViolations(page);
    page.on("console", (m) => {
      if (/\[network\]/.test(m.text())) console.log(`[page] ${m.text()}`);
    });
    // Turnstile under the page's COOP/COEP: its script and its frame.
    const turnstile: string[] = [];
    page.on("requestfinished", (request) => {
      if (request.url().startsWith(TURNSTILE_ORIGIN)) {
        turnstile.push(request.resourceType());
      }
    });
    await page.goto(`${site.url}/`);
    await page.getByTestId("start-sandbox").click();
    await page.evaluate(() =>
      (globalThis as unknown as { yurt: { ready: Promise<void> } }).yurt.ready
    );
    const toggle = page.getByTestId("network-toggle");
    await toggle.waitFor({ state: "visible" });
    expect(
      "the network starts off",
      await toggle.getAttribute("aria-pressed") === "false",
      await toggle.textContent(),
    );

    // Off: no name resolves, and no connect leaves.
    const offName = await exec(
      page,
      "curl -sS --max-time 20 https://pypi.org/simple/ -o /dev/null",
    );
    expect(
      "off: curl cannot resolve pypi.org",
      offName.code !== 0 && /resolve/i.test(offName.stderr),
      offName,
    );
    const offConnect = await exec(
      page,
      "curl -sS --max-time 20 http://151.101.0.223/ -o /dev/null",
    );
    expect(
      "off: a connect to a public address is refused",
      // curl's "Could not connect" (7), at once: not a timeout (28).
      offConnect.code === 7,
      offConnect,
    );
    expect(
      "off: the relay saw nothing",
      relay.usage.tokens.size === 0 && relay.usage.clients.size === 0,
      [...relay.usage.tokens, ...relay.usage.clients],
    );

    await toggle.click();
    await page.getByTestId("network-note").waitFor({ state: "visible" });
    expect(
      "the toggle turns it on",
      await toggle.getAttribute("aria-pressed") === "true",
      await toggle.textContent(),
    );

    // At once, while the first token's Turnstile check is still running:
    // the very first lookup must still resolve.
    const first = await exec(
      page,
      "wget -q -O /dev/null http://pypi.org/simple/ 2>&1; " +
        "curl -sS --max-time 60 -o /dev/null -w '%{http_code}' https://pypi.org/simple/",
    );
    expect(
      "on: the first lookup waits for the first token",
      first.code === 0 &&
        !/bad address|resolve/i.test(first.stdout + first.stderr),
      first,
    );
    turnstileWaitMs = 0;

    const simple = await exec(
      page,
      "curl -sS --max-time 60 https://pypi.org/simple/ | head -c 400",
    );
    console.log(simple.stdout.slice(0, 200));
    expect(
      "on: curl https://pypi.org/simple/ through the relay",
      simple.code === 0 && /simple index|<html|<!DOCTYPE/i.test(simple.stdout),
      simple,
    );

    // A download well past the relay's 2 MiB window: it runs on credit.
    const whole = await exec(
      page,
      "curl -sS --max-time 180 https://pypi.org/simple/ | wc -c",
      200_000,
    );
    expect(
      "on: the whole simple index (many windows' worth) arrives",
      whole.code === 0 && Number(whole.stdout.trim()) > 8 * 1024 * 1024,
      whole,
    );
    console.log(`  ${whole.stdout.trim()} bytes`);

    expect(
      "Turnstile's script and challenge frame loaded in the isolated page",
      // The token behind the curl above needed the widget's answer.
      turnstile.includes("script") && turnstile.includes("document"),
      turnstile,
    );

    // Refusals stay refusals with the network on.
    const port = await exec(
      page,
      "curl -sS --max-time 20 http://151.101.0.223:8080/ -o /dev/null",
    );
    expect("on: port 8080 is refused", port.code !== 0, port);
    const local = await exec(
      page,
      "curl -sS --max-time 20 http://192.168.1.1/ -o /dev/null",
    );
    expect("on: a private address is refused", local.code !== 0, local);

    // The kill switch: a slow download is cut.
    const slow = exec(
      page,
      "curl -sS --limit-rate 2k --max-time 120 https://pypi.org/simple/ -o /dev/null",
    );
    await page.waitForFunction(() =>
      document.querySelector("[data-testid=network-open]")?.textContent ===
        "1 open"
    );
    await page.getByTestId("network-cut").click();
    const cut = await slow;
    expect("Cut connections ends an open download", cut.code !== 0, cut);

    // pip, once the page's Python is installed.
    let pipReady: Exec | undefined;
    for (let i = 0; i < 150; i++) {
      pipReady = await exec(page, "python3 -m pip --version");
      if (pipReady.code === 0) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    expect(
      "the page installed Python with pip",
      pipReady?.code === 0,
      pipReady,
    );
    const pip = await exec(
      page,
      "python3 -m pip install --no-cache-dir requests 2>&1 | tail -5 && python3 -c 'import requests; print(requests.__version__)'",
      300_000,
    );
    console.log(pip.stdout);
    expect(
      "on: pip install requests",
      pip.code === 0 && /^\d+\.\d+/m.test(pip.stdout),
      pip,
    );

    await toggle.click();
    const offAgain = await exec(
      page,
      "curl -sS --max-time 20 https://pypi.org/simple/ -o /dev/null",
    );
    expect("off again: curl fails", offAgain.code !== 0, offAgain);
    checkCsp();
    await page.close();
    await notebookHasTheNetwork(browser, site.url);
  } finally {
    await browser.close();
    await relay.shutdown();
    await site.server.shutdown();
  }
}
