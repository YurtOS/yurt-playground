/**
 * The in-tab sandbox's network through the relay (#380), end to end in
 * Chrome: a local relay (relay/deno.ts) on this machine, the page told
 * about it as config/network.json would, and the guest's own curl and pip
 * reaching PyPI through it. Needs the internet, so it is not a CI scene:
 *
 *   deno run --allow-all tests/network_e2e.ts
 */
import type { Page } from "playwright";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launchBrowser } from "../scripts/browser.ts";
import { ensureBundle } from "../scripts/serve.ts";
import { handlePlaygroundRequest } from "../src/serve.ts";
import { withRelay } from "../src/csp.ts";
import { NETWORK_CONFIG_PATH } from "../src/network_config.ts";
import { startDenoRelay } from "../relay/deno.ts";
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
        return Response.json({ relay: relay() });
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

if (import.meta.main) {
  await ensureBundle(
    Deno.env.get("YURT_KERNEL_ROOT") ?? join(repoRoot, "../yurtos-kernel"),
  );
  let relayUrl = "";
  const site = serveWithRelay(() => relayUrl);
  const relay = startDenoRelay({
    secret: crypto.randomUUID(),
    allowedOrigins: [site.url],
  });
  relayUrl = relay.url;
  const browser = await launchBrowser();
  try {
    const page = await (await browser.newContext()).newPage();
    const checkCsp = watchCspViolations(page);
    page.on("console", (m) => {
      if (/\[network\]/.test(m.text())) console.log(`[page] ${m.text()}`);
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
  } finally {
    await browser.close();
    await relay.shutdown();
    await site.server.shutdown();
  }
}
