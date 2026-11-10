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

    // An approval is the asking document's, never a frame's: a page whose
    // top document is approved, with a same-origin frame (the playground
    // itself allows no frames; JupyterLite opens as pages of its own).
    const framed = Deno.serve(
      { port: 0, hostname: "127.0.0.1", onListen: () => {} },
      (req) =>
        new Response(
          new URL(req.url).pathname === "/"
            ? '<iframe id="inner" src="/inner"></iframe>'
            : "<p>inner</p>",
          { headers: { "content-type": "text/html" } },
        ),
    );
    const framedPage = await context.newPage();
    await framedPage.goto(`http://127.0.0.1:${framed.addr.port}/`);
    const callFrom = (frame: import("playwright").Frame, method: string) =>
      frame.evaluate(([id, method]) =>
        new Promise<string>((resolve) => {
          const port = (globalThis as unknown as {
            chrome: {
              runtime: {
                connect(id: string): {
                  postMessage(m: unknown): void;
                  onMessage: {
                    addListener(
                      fn: (
                        m: {
                          result?: { allowed?: boolean };
                          error?: { message: string };
                        },
                      ) => void,
                    ): void;
                  };
                  onDisconnect: { addListener(fn: () => void): void };
                };
              };
            };
          }).chrome.runtime.connect(id);
          port.onMessage.addListener((m) =>
            resolve(
              m.error?.message ?? JSON.stringify(m.result ?? "answered"),
            )
          );
          port.onDisconnect.addListener(() => resolve("disconnected"));
          port.postMessage({ id: 1, method });
        }), ["leelndonobmigkkkogijljomjikkefbe", method] as const);
    const topAnswer = await callFrom(framedPage.mainFrame(), "Yurt.approve");
    const askedAfterTop = asked;
    const inner = framedPage.frames().find((f) => f.url().endsWith("/inner"))!;
    const fromFrame = await callFrom(inner, "Browser.getVersion");
    if (
      topAnswer !== '{"allowed":true}' || !/not allowed/.test(fromFrame) ||
      asked !== askedAfterTop
    ) {
      fail(
        `approved top ${topAnswer}, frame ${fromFrame}, windows ${askedAfterTop} -> ${asked}`,
      );
    }
    // Only the playground's own page may ask: a JupyterLite page (a top
    // document under /jupyter/, which renders notebook output) is a no
    // without a window.
    const lite = await context.newPage();
    await lite.goto(`http://127.0.0.1:${framed.addr.port}/jupyter/lab/`);
    const liteAnswer = await callFrom(lite.mainFrame(), "Yurt.approve");
    if (liteAnswer !== '{"allowed":false}' || asked !== askedAfterTop) {
      fail(`a JupyterLite page could ask: ${liteAnswer}, windows ${asked}`);
    }
    await lite.close();
    await framedPage.close();
    await framed.shutdown();
    console.log(
      `browser bridge e2e: the top document allowed, its frame: ${fromFrame}`,
    );

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
    // Windows: the denied page, setup, the framed page's top: none when
    // the script connected.
    if ((asked as number) !== 3) {
      fail(`expected three approval windows in all, saw ${asked}`);
    }
    if (!result.stdout.includes("title: Yurt playground: this page cannot")) {
      fail(`the example read the wrong page: ${result.stdout}`);
    }
    // The tab it opened is this browser's: the extension made it.
    const urls = context.pages().map((p) => p.url());
    if (!urls.includes(target)) fail(`no tab on ${target}: ${urls}`);
    // A script sends tabs to the web only: the extension's own page (which
    // runs with its powers) is refused, by createTarget and by navigate.
    const escape = await page.evaluate(async () => {
      const yurt = (globalThis as unknown as {
        yurt: {
          fs: { write(path: string, data: string): Promise<void> };
          exec(cmd: string): Promise<{ stdout: string }>;
        };
      }).yurt;
      await yurt.fs.write(
        "/home/user/escape.js",
        `const { connect } = require("yurt-chrome");
const own = "chrome-extension://leelndonobmigkkkogijljomjikkefbe/approve.html";
(async () => {
  const browser = await connect();
  const page = await browser.contexts()[0].newPage();
  for (const step of [() => page.goto(own), () => page.goto("file:///etc/passwd")]) {
    await step().then(() => console.log("OPENED"), (e) => console.log("refused:", e.message.split("\\n")[0]));
  }
  await page.close();
  await browser.close();
})();`,
      );
      return (await yurt.exec("node escape.js")).stdout.trim();
    });
    if (
      escape.includes("OPENED") || (escape.match(/refused/g) ?? []).length !== 2
    ) {
      fail(`a script reached a non-web page: ${escape}`);
    }
    console.log(`browser bridge e2e: ${escape.replace(/\n/g, "; ")}`);
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
