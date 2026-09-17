// The desktop app, end to end: the launcher inside the bundle built for
// this machine (scripts/build-desktop.sh) boots the native sandbox it
// carries, serves the site, and in a real browser Jupyter runs a cell and
// reaches the internet from the guest. Run it after the build; it is the
// acceptance for the shipped artifact, not the source tree.
import { chromium } from "playwright";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EXECUTE_TIMEOUT_MS } from "../src/jupyter.ts";
import { watchCspViolations } from "./csp_watch.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
/** The binary inside the bundle built for this machine. */
const binary = join(
  repoRoot,
  "dist-desktop",
  Deno.build.target,
  Deno.build.os === "darwin"
    ? "Yurt Playground.app/Contents/MacOS/yurt-playground"
    : "yurt-playground/yurt-playground",
);

/** Start the binary with stdout piped (so it does not open a browser) and
 * read the URL and the API token it announces. */
async function startApp(): Promise<
  { url: string; apiToken: string; stop: () => void }
> {
  const child = new Deno.Command(binary, { stdout: "piped", stderr: "inherit" })
    .spawn();
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const url = text.match(/^Yurt playground: (http:\/\/127\.0\.0\.1:\d+\/)$/m);
    const token = text.match(/^API token: ([0-9a-f]+)$/m);
    if (url && token) {
      return {
        url: url[1],
        apiToken: token[1],
        stop: () => {
          child.kill("SIGTERM");
          reader.cancel().catch(() => undefined);
        },
      };
    }
    const { value, done } = await reader.read();
    if (done) throw new Error(`${binary} exited without announcing a URL`);
    text += decoder.decode(value, { stream: true });
  }
}

/** The first yurt-desktop-host with the session and file routes the API
 * is built on (yurt-sandbox#264). With an older pin the API scenes are
 * skipped, loudly; from this release on they are required, so the pin
 * bump arms them by itself. */
const API_HOST_RELEASE = [0, 1, 3];

async function apiExpected(): Promise<boolean> {
  const pins = JSON.parse(
    await Deno.readTextFile(join(repoRoot, "artifacts", "pins.json")),
  );
  const version = String(pins.desktopHost?.release ?? "").match(
    /v(\d+)\.(\d+)\.(\d+)$/,
  );
  if (version === null) return true;
  const pinned = version.slice(1).map(Number);
  for (let i = 0; i < 3; i++) {
    if (pinned[i] !== API_HOST_RELEASE[i]) {
      return pinned[i] > API_HOST_RELEASE[i];
    }
  }
  return true;
}

/** The launcher's /api/* as a program on the machine uses it: the token
 * from the announce, a command with its streams and status, a pipeline
 * the deadline kills whole, a file both ways (README, "Driving the
 * sandbox from a program"). False when the bundled host predates it. */
async function driveApi(
  app: { url: string; apiToken: string },
): Promise<boolean> {
  const api = async (path: string, init: RequestInit = {}) => {
    const response = await fetch(`${app.url}api${path}`, {
      ...init,
      headers: { ...init.headers, authorization: `Bearer ${app.apiToken}` },
    });
    return response;
  };
  const exec = async (body: Record<string, unknown>) => {
    const started = await api("/executions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (started.status !== 201) {
      throw new Error(
        `POST /api/executions: ${started.status} ${await started.text()}`,
      );
    }
    const { id } = await started.json();
    return await (await api(`/executions/${id}?wait=1`)).json();
  };
  const noToken = await fetch(`${app.url}api/status`);
  if (noToken.status !== 401) throw new Error(`no token: ${noToken.status}`);
  await noToken.body?.cancel();
  const statusResponse = await api("/status");
  const status = await statusResponse.json();
  if (statusResponse.status === 503 && status.code === "HostTooOld") {
    if (await apiExpected()) {
      throw new Error(
        `the bundled host has no session routes: ${status.error}`,
      );
    }
    console.log(
      "desktop e2e: SKIPPING /api/* and window.yurt: the pinned yurt-desktop-host predates the session routes",
    );
    return false;
  }
  if (status.native !== true || status.status !== "running") {
    throw new Error(`/api/status: ${JSON.stringify(status)}`);
  }
  const result = await exec({
    cmd: "pwd; tr a-z A-Z; echo err >&2; exit 7",
    stdin: "abc\n",
  });
  if (
    result.code !== 7 || result.stdout !== "/home/user\nABC\n" ||
    result.stderr !== "err\n"
  ) {
    throw new Error(`exec: ${JSON.stringify(result)}`);
  }
  const started = Date.now();
  const killed = await exec({ cmd: "sleep 60 | sleep 60", timeoutMs: 1500 });
  if (killed.signal !== "SIGKILL" || killed.timedOut !== true) {
    throw new Error(`timeout: ${JSON.stringify(killed)}`);
  }
  if (Date.now() - started > 20_000) {
    throw new Error(`the deadline took ${Date.now() - started} ms`);
  }
  const left = await exec({ cmd: "pgrep sleep | wc -l" });
  if (left.stdout.trim() !== "0") {
    throw new Error(`sleeps survived the kill: ${JSON.stringify(left)}`);
  }
  const bytes = new Uint8Array([0, 255, 10, 65]);
  const put = await api("/fs/content?path=/home/user/api.bin", {
    method: "PUT",
    headers: { "x-yurt-mode": "600" },
    body: bytes,
  });
  if (put.status !== 204) {
    throw new Error(`PUT: ${put.status} ${await put.text()}`);
  }
  const back = new Uint8Array(
    await (await api("/fs/content?path=/home/user/api.bin")).arrayBuffer(),
  );
  if (back.join(",") !== bytes.join(",")) {
    throw new Error(`fs round trip: ${back}`);
  }
  const entries = await (await api("/fs/entries?path=/home/user")).json();
  const entry = entries.find((e: { name: string }) => e.name === "api.bin");
  if (entry?.size !== 4 || entry?.mode !== 0o600) {
    throw new Error(`fs/entries: ${JSON.stringify(entries)}`);
  }
  console.log(
    "desktop e2e: /api/* ran a command, killed a pipeline, moved a file",
  );
  return true;
}

if (import.meta.main) {
  const app = await startApp();
  const apiPresent = await driveApi(app);
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const started = Date.now();
    const csp = watchCspViolations(page);
    // The app runs the sandbox natively: the launcher says so, and the boot
    // it reports is seconds, not the tab's minutes.
    const desktop = await (await fetch(`${app.url}desktop.json`)).json();
    if (desktop.native !== true) {
      throw new Error(`desktop.json is not native: ${JSON.stringify(desktop)}`);
    }
    if (typeof desktop.bootMs !== "number" || desktop.bootMs > 60_000) {
      throw new Error(`native boot took ${desktop.bootMs} ms`);
    }
    console.log(`desktop e2e: native sandbox booted in ${desktop.bootMs} ms`);
    await page.goto(`${app.url}?start=1`, {
      waitUntil: "domcontentloaded",
    });
    await page.getByTestId("notebook-status").waitFor({
      state: "visible",
      timeout: 30_000,
    });
    // The header says where the sandbox is (yurt-playground#89).
    const lead = await page.locator("#lead").textContent();
    if (!(lead ?? "").includes("natively")) {
      throw new Error(`the native page still claims the tab: ${lead}`);
    }
    if (await page.locator("#offline-note").isVisible()) {
      throw new Error("the native page still says the sandbox has no network");
    }
    // Same budget as playground_e2e.ts: ~30 s on a laptop, several times
    // that on a small CI runner.
    await page.waitForFunction(
      () => {
        const notebook = document.querySelector<HTMLElement>(
          "[data-testid=notebook-status]",
        );
        const status = document.querySelector<HTMLElement>("#status");
        return notebook?.textContent === "ready" ||
          (status?.textContent ?? "").includes("failed");
      },
      undefined,
      { timeout: 300_000 },
    ).catch(() => undefined);
    if (await page.getByTestId("notebook-status").textContent() !== "ready") {
      const status = await page.locator("#status").textContent();
      throw new Error(
        `Jupyter did not become ready after ${
          Math.round((Date.now() - started) / 1000)
        } s: status=${status}`,
      );
    }
    const cellDone = (expected: string) =>
      page.waitForFunction(
        (want) => {
          const text = document.querySelector<HTMLElement>(
            "[data-testid=notebook-output]",
          )?.textContent ?? "";
          if (text === want) return true;
          if (/timed out|Error|Traceback/.test(text)) {
            throw new Error(`cell failed: ${text}`);
          }
          return false;
        },
        expected,
        { timeout: EXECUTE_TIMEOUT_MS + 10_000 },
      );
    await page.getByTestId("notebook-input").fill("1+1");
    await page.getByTestId("notebook-execute").click();
    await cellDone("2");
    console.log(
      `desktop e2e: first cell done after ${
        Math.round((Date.now() - started) / 1000)
      } s`,
    );
    // What the native app is for: the guest reaches the internet, over TLS.
    await page.getByTestId("notebook-input").fill(
      "import urllib.request; urllib.request.urlopen('https://example.com', timeout=30).status",
    );
    await page.getByTestId("notebook-execute").click();
    await cellDone("200");
    // A shell cell: IPython's `!` goes pexpect -> ptyprocess -> resource,
    // then posix_spawn; both work on the native runtime (#4; the in-tab
    // kernel still cannot spawn, yurtos-kernel#2771). The output is what
    // BusyBox echo wrote, streamed as stdout.
    await page.getByTestId("notebook-input").fill("!echo hi");
    await page.getByTestId("notebook-execute").click();
    await cellDone("hi\n");
    console.log("desktop e2e: !echo hi ran in BusyBox");
    // window.yurt on the native page: the launcher's registry, reached
    // with the token /desktop.json gave the page; bytes through /api/fs.
    const driven = !apiPresent ? undefined : await page.evaluate(async () => {
      const yurt = (globalThis as unknown as {
        yurt: {
          exec: (
            cmd: string,
            opts?: Record<string, unknown>,
          ) => Promise<Record<string, unknown>>;
          fs: {
            write: (
              path: string,
              data: Uint8Array,
              opts?: Record<string, unknown>,
            ) => Promise<void>;
            read: (path: string) => Promise<Uint8Array>;
          };
        };
      }).yurt;
      const result = await yurt.exec("tr a-z A-Z; exit 3", { stdin: "abc" });
      await yurt.fs.write("/home/user/page.bin", new Uint8Array([0, 255]));
      const back = Array.from(await yurt.fs.read("/home/user/page.bin"));
      return { result, back };
    });
    if (driven !== undefined) {
      if (driven.result.code !== 3 || driven.result.stdout !== "ABC") {
        throw new Error(`window.yurt.exec: ${JSON.stringify(driven.result)}`);
      }
      if (driven.back.join(",") !== "0,255") {
        throw new Error(`window.yurt.fs: ${driven.back}`);
      }
      console.log("desktop e2e: window.yurt drove the native sandbox");
    }
    // The Notebook page too: its kernel plugin lives under /jupyter/ and must
    // find the launcher's /desktop.json from there (the bundle has no in-tab
    // kernel to fall back to).
    await page.goto(
      `${app.url}jupyter/notebooks/index.html?path=welcome.ipynb`,
      {
        waitUntil: "domcontentloaded",
      },
    );
    await page.locator(".jp-Notebook").first().waitFor({ timeout: 60_000 });
    await page.waitForFunction(
      () =>
        document.querySelector(".jp-Toolbar-kernelName")?.textContent
            ?.includes("Yurt") === true &&
        document.querySelector(".jp-Notebook-ExecutionIndicator")
            ?.getAttribute("data-status") === "idle",
      undefined,
      { timeout: 120_000 },
    );
    console.log(
      `desktop e2e: notebook kernel idle after ${
        Math.round((Date.now() - started) / 1000)
      } s`,
    );
    csp();
    console.log(
      `desktop e2e: Jupyter cells ran after ${
        Math.round((Date.now() - started) / 1000)
      } s`,
    );
  } finally {
    await browser.close();
    app.stop();
  }
}
