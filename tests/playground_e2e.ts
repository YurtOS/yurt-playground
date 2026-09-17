import { chromium, devices, type Page } from "playwright";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureBundle } from "../scripts/serve.ts";
import { startPlaygroundServer } from "../src/serve.ts";
import { EXECUTE_TIMEOUT_MS } from "../src/jupyter.ts";
import { watchCspViolations } from "./csp_watch.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** "Run it on your machine" is a radio group behind four labels: Tab lands
 * on the chosen one, the arrow keys move the choice and the panel with it,
 * and the ring shows on the label of the focused radio. */
async function installChoicesWorkByKeyboard(page: Page): Promise<void> {
  const shown = () =>
    page.evaluate(() => {
      const panel = [
        ...document.querySelectorAll<HTMLElement>("#install .panel"),
      ]
        .find((p) => getComputedStyle(p).display !== "none");
      const focused = document.activeElement as HTMLInputElement | null;
      const label = focused?.id
        ? document.querySelector<HTMLElement>(`label[for="${focused.id}"]`)
        : null;
      return {
        panel: panel?.className.replace("panel ", ""),
        focused: focused?.id,
        ringed: label ? getComputedStyle(label).outlineStyle !== "none" : false,
      };
    });
  await page.locator("#install-app-mac").focus();
  // A pointer focus draws no ring; the keyboard's does.
  await page.keyboard.press("ArrowDown");
  const order = ["app-linux", "cli-mac", "cli-linux", "app-mac"];
  for (const expected of order) {
    const state = await shown();
    if (
      state.panel !== expected || state.focused !== `install-${expected}` ||
      !state.ringed
    ) {
      throw new Error(
        `install choice by keyboard: want ${expected} focused, shown and ringed, got ${
          JSON.stringify(state)
        }`,
      );
    }
    await page.keyboard.press("ArrowDown");
  }
}

type FailurePane = {
  status: string | null;
  start: boolean;
  why: string[];
  reason: string | null;
};

function readFailurePane(page: Page): Promise<FailurePane> {
  return page.evaluate(() => {
    const hidden = (id: string) =>
      document.querySelector<HTMLElement>(`#${id}`)!.hidden;
    return {
      status: document.querySelector("#status")!.textContent,
      start: hidden("start"),
      why: [...document.querySelectorAll<HTMLElement>("#failed [data-why]")]
        .filter((p) => !p.hidden).map((p) => p.dataset.why!),
      reason: hidden("failed-reason")
        ? null
        : document.querySelector("#failed-reason")!.textContent,
    };
  });
}

function expectPane(name: string, got: FailurePane, want: FailurePane): void {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    throw new Error(
      `${name}: want ${JSON.stringify(want)}, got ${JSON.stringify(got)}`,
    );
  }
}

/** What the page knows before and after a boot it could not finish: a phone
 * is refused at Start (an iPhone is reloaded at "starting Jupyter"); a boot
 * that dies in-page explains itself in the terminal's place, with the likely
 * cause on a tablet; and a tab the browser reloaded mid-boot says so on the
 * next load instead of offering a fresh Start. */
async function bootFailuresAreExplained(
  browser: Awaited<ReturnType<typeof chromium.launch>>,
  url: string,
): Promise<void> {
  // On a timeout, say what the page was doing: its status line, where it
  // is, and what it logged — a hidden pane alone does not tell fetch from
  // redirect from a script that never ran.
  const failed = async (page: Page) => {
    const logs: string[] = [];
    const onConsole = (m: { type: () => string; text: () => string }) =>
      logs.push(`${m.type()}: ${m.text()}`);
    const onError = (e: Error) => logs.push(`pageerror: ${e.message}`);
    page.on("console", onConsole);
    page.on("pageerror", onError);
    try {
      await page.getByTestId("boot-failed").waitFor({ state: "visible" });
    } catch (error) {
      const state = await page.evaluate(() => ({
        href: location.href,
        readyState: document.readyState,
        status: document.querySelector("#status")?.textContent,
        isolated: globalThis.crossOriginIsolated,
        ua: navigator.userAgent,
      })).catch((e) => `evaluate failed: ${e}`);
      throw new Error(
        `boot-failed never showed; page ${JSON.stringify(state)}; console ${
          JSON.stringify(logs)
        }`,
        { cause: error },
      );
    } finally {
      page.off("console", onConsole);
      page.off("pageerror", onError);
    }
  };
  const phone = await browser.newContext(devices["iPhone 13"]);
  const phonePage = await phone.newPage();
  await phonePage.goto(`${url}/?start`, { waitUntil: "domcontentloaded" });
  await failed(phonePage);
  expectPane("phone", await readFailurePane(phonePage), {
    status: "failed",
    start: true,
    why: ["phone"],
    reason: null,
  });
  await phone.close();

  const reason = "fetch ./yurt_kernel.wasm failed: 503";
  for (const tablet of [true, false]) {
    const context = await browser.newContext(
      tablet ? devices["iPad Pro 11"] : {},
    );
    const page = await context.newPage();
    await page.route(
      "**/yurt_kernel.wasm",
      (route) => route.fulfill({ status: 503 }),
    );
    await page.goto(`${url}/?start`, { waitUntil: "domcontentloaded" });
    await failed(page);
    expectPane(tablet ? "tablet" : "desktop", await readFailurePane(page), {
      status: "failed",
      start: true,
      why: [tablet ? "tablet" : "error"],
      reason,
    });
    await context.close();
  }

  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${url}/`, { waitUntil: "domcontentloaded" });
  // The page reads and clears the boot memory once it has asked the host
  // whether it is the app; plant one only after that, or this load takes it
  // and the reload finds nothing (a race CI lost, run 35144362670).
  await page.waitForFunction(() =>
    document.documentElement.dataset.settled !== undefined
  );
  // The boot memory a killed tab leaves behind.
  await page.evaluate(() =>
    sessionStorage.setItem("yurt-playground-booting", "starting Jupyter")
  );
  await page.reload({ waitUntil: "domcontentloaded" });
  await failed(page);
  expectPane("reloaded", await readFailurePane(page), {
    status: "failed",
    start: true,
    why: ["reloaded"],
    reason: "starting Jupyter",
  });
  // Explained once; the next visit is a fresh Start.
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByTestId("start-sandbox").waitFor({ state: "visible" });
  await context.close();
}

if (import.meta.main) {
  await ensureBundle(
    Deno.env.get("YURT_KERNEL_ROOT") ?? join(repoRoot, "../yurtos-kernel"),
  );
  const server = startPlaygroundServer(0);
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const started = Date.now();
    const csp = watchCspViolations(page);
    // The primary flow: the home page, and the one action on it.
    await page.goto(`${server.url}/`, { waitUntil: "domcontentloaded" });
    if (await page.evaluate(() => globalThis.crossOriginIsolated !== true)) {
      throw new Error("browser page is not cross-origin isolated");
    }
    await installChoicesWorkByKeyboard(page);
    await page.getByTestId("start-sandbox").click();
    // The button yields to the boot; the cell is part of the workspace.
    await page.getByTestId("start-sandbox").waitFor({ state: "hidden" });
    await page.getByTestId("notebook-status").waitFor({
      state: "visible",
      timeout: 30_000,
    });
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
      // Measured 2026-09-14: ~30 s from page load to ready on an M-series
      // laptop (cold import of ipykernel + pyzmq in the browser JIT); a
      // 2-vCPU CI runner needs several times that.
      { timeout: 300_000 },
    ).catch(() => undefined);
    if (await page.getByTestId("notebook-status").textContent() !== "ready") {
      const status = await page.locator("#status").textContent();
      const notebook = await page.getByTestId("notebook-status").textContent();
      throw new Error(
        `Jupyter did not become ready after ${
          Math.round((Date.now() - started) / 1000)
        } s: status=${status} notebook=${notebook}`,
      );
    }
    console.log(
      `playground e2e: Jupyter ready after ${
        Math.round((Date.now() - started) / 1000)
      } s`,
    );
    await page.getByTestId("notebook-input").fill("1+1");
    await page.getByTestId("notebook-execute").click();
    await page.getByTestId("notebook-output").waitFor({ state: "visible" });
    // A cell error lands in the same element, so a wrong answer fails fast
    // instead of waiting out the timeout.
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
    await cellDone("2");
    console.log(
      `playground e2e: first cell done after ${
        Math.round((Date.now() - started) / 1000)
      } s`,
    );
    // The proof the home page advertises: with the network gone, the next
    // cell still runs, and the page says so.
    await page.context().setOffline(true);
    await page.waitForFunction(() =>
      document.querySelector("[data-testid=net]")?.getAttribute(
        "data-online",
      ) === "false"
    );
    // `int(...)`: numpy 2 displays its scalars as `np.int32(3)`.
    await page.getByTestId("notebook-input").fill(
      "import numpy as np; int(np.array([1, 2]).sum())",
    );
    await page.getByTestId("notebook-execute").click();
    await cellDone("3");
    await page.context().setOffline(false);
    await page.waitForFunction(() =>
      document.querySelector("[data-testid=net]")?.getAttribute(
        "data-online",
      ) === "true"
    );
    // A shell cell, as desktop_e2e runs it: the image's yurt_shell_cells
    // takes `!` through subprocess -> vfork, which the JS host serves since
    // kernel-wasm-v0.0.3 (yurtos-kernel#2774; #62). `os.system`/posix_spawn
    // still hang there (yurtos-kernel#2771), but `!` never takes that path.
    await page.getByTestId("notebook-input").fill("!echo hi");
    await page.getByTestId("notebook-execute").click();
    await cellDone("hi\n");
    console.log("playground e2e: !echo hi ran in BusyBox");
    // window.yurt (#79): a driver's exec with exit status and separate
    // streams, stdin into a pipeline, a bounded capture, files in and
    // out, a listing that survives awkward names, and a timeout that kills.
    const driven = await page.evaluate(async () => {
      const y = (globalThis as unknown as {
        yurt: {
          status: string;
          ready: Promise<void>;
          exec(
            cmd: string,
            opts?: Record<string, unknown>,
          ): Promise<Record<string, unknown>>;
          fs: {
            read(p: string): Promise<Uint8Array>;
            write(
              p: string,
              d: string | Uint8Array,
              o?: Record<string, unknown>,
            ): Promise<void>;
            list(p: string): Promise<Array<Record<string, unknown>>>;
          };
        };
      }).yurt;
      await y.ready;
      const status = y.status;
      const attr = document.documentElement.dataset.yurtStatus;
      const both = await y.exec("echo out; echo err 1>&2; exit 7");
      const piped = await y.exec("cat | tr a-z A-Z", { stdin: "fed\n" });
      // Not `yes | head`: a writer on a reader-less pipe gets no EPIPE in
      // the guest yet and would spin until the timeout.
      const bounded = await y.exec(
        "i=0; while [ $i -lt 500 ]; do echo 0123456789; i=$((i+1)); done",
        { maxOutputBytes: 100 },
      );
      await y.fs.write("/home/user/drv.txt", "driven\n", { mode: 0o600 });
      const read = new TextDecoder().decode(
        await y.fs.read("/home/user/drv.txt"),
      );
      await y.exec(
        "cd /home/user && mkdir drv && printf x > 'drv/with space' && printf ab > \"drv/new\nline\"",
      );
      const list = await y.fs.list("/home/user/drv");
      // Bytes the console line discipline would eat or act on (CR, VEOF,
      // VERASE, VKILL, NUL, VQUIT, VSUSP), and a file past any single
      // buffer, both exact.
      const ctl = new Uint8Array([13, 10, 3, 4, 127, 21, 0, 28, 26, 255]);
      const ctlBack = (await y.exec("od -c", { stdin: ctl })).stdout;
      const big = new Uint8Array(200_000);
      for (let i = 0; i < big.length; i++) big[i] = (i * 7 + 3) & 255;
      await y.fs.write("/home/user/big.bin", big);
      const bigBack = await y.fs.read("/home/user/big.bin");
      const bigExact = bigBack.length === big.length &&
        bigBack.every((b, i) => b === big[i]);
      const t0 = Date.now();
      // A pipeline: the deadline must take the whole process group.
      const timed = await y.exec("sleep 60 | sleep 60; echo never", {
        timeoutMs: 1000,
      });
      const ms = Date.now() - t0;
      const survivors = (await y.exec(
        'for p in $(ps | awk \'$4=="sleep" && $5=="60" {print $1}\'); do kill -0 $p 2>/dev/null && echo alive $p; done; echo checked',
      )).stdout;
      return {
        status,
        attr,
        both,
        piped,
        bounded,
        read,
        list,
        timed,
        ms,
        ctlBack,
        bigExact,
        survivors,
      };
    });
    const expect = (what: string, ok: boolean, got: unknown) => {
      if (!ok) throw new Error(`window.yurt ${what}: ${JSON.stringify(got)}`);
    };
    expect(
      "status",
      driven.status === "running" && driven.attr === "running",
      driven,
    );
    expect(
      "exec streams and status",
      driven.both.stdout === "out\n" && driven.both.stderr === "err\n" &&
        driven.both.code === 7,
      driven.both,
    );
    expect(
      "stdin into a pipeline",
      driven.piped.stdout === "FED\n",
      driven.piped,
    );
    expect(
      "bounded capture",
      (driven.bounded.stdout as string).length === 100 &&
        driven.bounded.stdoutTruncated === true,
      driven.bounded,
    );
    expect("fs round trip", driven.read === "driven\n", driven.read);
    expect(
      "listing",
      driven.list.length === 2 &&
        driven.list.some((e) =>
          e.name === "with space" && e.type === "file" && e.size === 1
        ) &&
        driven.list.some((e) => e.name === "new\nline" && e.size === 2),
      driven.list,
    );
    expect(
      "binary stdin",
      (driven.ctlBack as string).replace(/\s+/g, " ").includes(
        "\\r \\n 003 004 177 025 \\0 034 032 377",
      ),
      driven.ctlBack,
    );
    expect(
      "a 200 KB file round trip",
      driven.bigExact === true,
      driven.bigExact,
    );
    expect(
      "timeout kills the whole pipeline",
      driven.timed.timedOut === true && driven.timed.signal === "SIGKILL" &&
        driven.ms < 10000 && driven.survivors === "checked\n",
      { timed: driven.timed, survivors: driven.survivors },
    );
    console.log(
      `playground e2e: window.yurt drove the sandbox (timeout in ${driven.ms} ms)`,
    );
    // The cell and the ash terminal share one VFS: a file written by Python
    // is read back by the shell in the xterm (#4).
    await page.getByTestId("notebook-input").fill(
      "open('/tmp/from-cell', 'w').write('cell wrote this')",
    );
    await page.getByTestId("notebook-execute").click();
    await page.waitForFunction(() =>
      document.querySelector<HTMLElement>("[data-testid=notebook-output]")
        ?.textContent?.trim() === "15"
    );
    if (!(await page.locator("#term").isVisible())) {
      throw new Error("ash terminal is not visible");
    }
    await page.locator("#term").click();
    await page.keyboard.type("cat /tmp/from-cell; echo __VFS_DONE__\n");
    await page.waitForFunction(
      () => {
        const rows = document.querySelector("#term .xterm-rows")?.textContent ??
          "";
        return rows.includes("cell wrote this") &&
          rows.includes("__VFS_DONE__");
      },
      undefined,
      { timeout: 60_000 },
    );
    csp();
    // The failure scenes are fresh boots on their own pages; they must not
    // share the runner's CPU with this page's live sandbox (kernel and
    // Jupyter workers), which on a slow runner left the phone page's
    // `boot-failed` hidden past its 30 s wait (main run 35141812840).
    await page.close();
    await bootFailuresAreExplained(browser, server.url);
  } finally {
    await browser.close();
    await server.shutdown();
  }
}
