/**
 * Browser acceptance for Playwright in the in-tab sandbox: the page with
 * `?env=playwright`, in Chrome with the Yurt browser bridge extension
 * (extension/), asks a person (the extension's own window) and installs node
 * and playwright-core in the sandbox; then
 * `node playwright-example.js <url>` there opens a tab in this browser
 * through the guest's DevTools endpoint (src/cdp_bridge.ts), the page and
 * the extension, reads its title and screenshots it. Before that: a page
 * not set up for Playwright serves the guest no endpoint, and a script on
 * the site that calls the extension directly is stopped by a Deny.
 *
 * Run: deno run --allow-all tests/browser_bridge_e2e.ts (after
 * scripts/install-pinned-artifacts.sh, like the other scenes).
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launchWithExtension } from "../scripts/browser.ts";
import { ensureBundle } from "../scripts/serve.ts";
import { startPlaygroundServer } from "../src/serve.ts";
import { READY_NOTE } from "../src/playwright_demo.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function fail(message: string): never {
  throw new Error(message);
}

if (import.meta.main) {
  await ensureBundle(
    Deno.env.get("YURT_KERNEL_ROOT") ?? join(repoRoot, "../yurtos-kernel"),
  );
  const server = startPlaygroundServer(0);
  // The extension answers the site alone; this copy also answers the
  // local server the scene runs on.
  const extension = await Deno.makeTempDir({ prefix: "yurt-bridge-" });
  for await (const entry of Deno.readDir(join(repoRoot, "extension"))) {
    await Deno.copyFile(
      join(repoRoot, "extension", entry.name),
      join(extension, entry.name),
    );
  }
  const manifest = JSON.parse(
    await Deno.readTextFile(join(extension, "manifest.json")),
  );
  manifest.externally_connectable.matches.push("http://127.0.0.1/*");
  await Deno.writeTextFile(
    join(extension, "manifest.json"),
    JSON.stringify(manifest),
  );
  const context = await launchWithExtension(extension);

  try {
    // The extension's approval window (its own page, out of reach of page
    // and guest code): this scene answers it as a person would.
    let answer: "#deny" | "#allow" = "#deny";
    let asked = 0;
    const answerPopup = (popup: import("playwright").Page) => {
      asked++;
      void popup.click(answer).catch(() => {});
    };
    context.on("page", (popup) => {
      if (popup.url().includes("approve.html")) return answerPopup(popup);
      popup.waitForURL(/approve\.html/, { timeout: 5000 }).then(
        () => answerPopup(popup),
        () => {},
      );
    });

    // The extension alone opens nothing: a page not set up for Playwright
    // (the default Python one) serves the guest no DevTools endpoint.
    const plain = await context.newPage();
    await plain.goto(`${server.url}/?start&platform=desktop`, {
      waitUntil: "domcontentloaded",
    });
    await plain.waitForFunction(
      () => document.querySelector("#status")?.textContent === "running",
      undefined,
      { timeout: 300_000 },
    );
    const probe = await plain.evaluate(async () =>
      (await (globalThis as unknown as {
        yurt: { exec(cmd: string): Promise<{ stdout: string }> };
      }).yurt.exec(
        "wget -q -T 3 -O- http://127.0.0.1:9222/json/version || echo refused",
      )).stdout.trim()
    );
    if (probe !== "refused") fail(`the Python page serves CDP: ${probe}`);
    // A script on the site's origin (a notebook output, say) can reach the
    // extension itself; the person's answer is what stops it.
    const tabsBefore = context.pages().length;
    const callExtension = () =>
      plain.evaluate(
        (id) =>
          new Promise<string>((resolve) => {
            const port = (globalThis as unknown as {
              chrome: {
                runtime: {
                  connect(id: string): {
                    postMessage(m: unknown): void;
                    onMessage: {
                      addListener(
                        fn: (m: { error?: { message: string } }) => void,
                      ): void;
                    };
                    onDisconnect: { addListener(fn: () => void): void };
                  };
                };
              };
            }).chrome.runtime.connect(id);
            port.onMessage.addListener((m: { error?: { message: string } }) =>
              resolve(m.error?.message ?? "answered")
            );
            port.onDisconnect.addListener(() => resolve("disconnected"));
            port.postMessage({
              id: 1,
              method: "Target.createTarget",
              params: { url: "about:blank" },
            });
          }),
        "leelndonobmigkkkogijljomjikkefbe",
      );
    const hostile = await callExtension();
    if (!/not allowed/.test(hostile) || asked !== 1) {
      fail(`a denied page drove the browser: ${hostile} (asked ${asked})`);
    }
    if (
      context.pages().filter((p) => !p.url().includes("approve")).length >
        tabsBefore
    ) {
      fail("a denied page opened a tab");
    }
    console.log(
      `browser bridge e2e: denied in the approval window: ${hostile}`,
    );
    // The no is remembered for the tab: connecting again asks nobody.
    const again = await callExtension();
    if (!/not allowed/.test(again) || asked !== 1) {
      fail(`a denied tab was asked again: ${again} (asked ${asked})`);
    }
    answer = "#allow";
    await plain.close();
    console.log("browser bridge e2e: no endpoint without ?env=playwright");

    const page = await context.newPage();
    await page.goto(`${server.url}/?start&platform=desktop&env=playwright`, {
      waitUntil: "domcontentloaded",
    });
    await page.waitForFunction(
      (ready) =>
        (document.getElementById("platform-note-text")?.textContent ?? "")
          .includes(ready) ||
        /Playwright setup failed|not installed/.test(
          document.getElementById("platform-note-text")?.textContent ?? "",
        ),
      READY_NOTE,
      { timeout: 600_000 },
    );
    const note = await page.textContent("#platform-note-text");
    if (!note?.includes(READY_NOTE)) fail(`setup did not finish: ${note}`);
    console.log("browser bridge e2e: Playwright set up in the sandbox");

    const target = `${server.url}/unsupported.html`;
    const result = await page.evaluate(async (url) => {
      const yurt = (globalThis as unknown as {
        yurt: {
          exec(cmd: string): Promise<
            { code: number | null; stdout: string; stderr: string }
          >;
        };
      }).yurt;
      return await yurt.exec(`node playwright-example.js ${url}`);
    }, target);
    console.log(`browser bridge e2e: ${result.stdout.trim()}`);
    if (result.code !== 0) fail(`the example failed: ${result.stderr}`);
    // One window at setup, none when the script connected.
    if ((asked as number) !== 2) {
      fail(`expected one approval at setup, saw ${asked} windows in all`);
    }
    if (!result.stdout.includes("title: Yurt playground: this page cannot")) {
      fail(`the example read the wrong page: ${result.stdout}`);
    }
    // The tab it opened is this browser's: the extension made it.
    const urls = context.pages().map((p) => p.url());
    if (!urls.includes(target)) fail(`no tab on ${target}: ${urls}`);
    const shot = await page.evaluate(async () =>
      (await (globalThis as unknown as {
        yurt: { fs: { read(path: string): Promise<Uint8Array> } };
      }).yurt.fs.read("/home/user/playwright-example.png")).length
    );
    if (shot < 1000) fail(`the screenshot is ${shot} bytes`);
    console.log(
      `browser bridge e2e: a tab on ${target}, screenshot ${shot} bytes; passed`,
    );
  } finally {
    await context.close();
    await server.shutdown();
  }
}
