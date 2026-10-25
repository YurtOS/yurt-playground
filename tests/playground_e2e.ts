import { chromium, devices, type Page } from "playwright";
import { Buffer } from "node:buffer";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureBundle } from "../scripts/serve.ts";
import { startPlaygroundServer } from "../src/serve.ts";
import { EXECUTE_TIMEOUT_MS } from "../src/jupyter.ts";
import { watchCspViolations } from "./csp_watch.ts";
import { PACKAGE_REPO_URL } from "../src/packages.ts";

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
  title: string | null;
  notebook: string | null;
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
      title: document.querySelector("#failed-title")!.textContent,
      notebook: document.querySelector("#notebook-status")!.textContent,
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

/** A tablet runs the Linux shell only: no Python cell, no Notebook or
 * JupyterLab link, no agent, and no ipykernel in the guest — iPadOS refused
 * new processes after ~13 while ipykernel started. The boot ends at the
 * shell, and a later reload is not mistaken for a boot cut off midway. */
async function tabletIsShellOnly(
  browser: Awaited<ReturnType<typeof chromium.launch>>,
  url: string,
): Promise<void> {
  const context = await browser.newContext(devices["iPad Pro 11"]);
  const page = await context.newPage();
  await page.addInitScript(() => {
    const seen: string[] = [];
    (globalThis as { __statuses?: string[] }).__statuses = seen;
    document.addEventListener("DOMContentLoaded", () => {
      const status = document.querySelector("#status");
      if (status === null) return;
      new MutationObserver(() => seen.push(status.textContent ?? ""))
        .observe(status, {
          childList: true,
          characterData: true,
          subtree: true,
        });
    });
  });
  await page.goto(`${url}/?start`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => document.querySelector("#status")?.textContent === "running",
    undefined,
    { timeout: 180_000 },
  );
  const state = await page.evaluate(async () => {
    const yurt = (globalThis as unknown as {
      yurt: {
        exec(
          cmd: string,
        ): Promise<{ code: number; stdout: Uint8Array | string }>;
      };
    }).yurt;
    const text = (b: Uint8Array | string) =>
      typeof b === "string" ? b : new TextDecoder().decode(b);
    const ps = await yurt.exec("ps");
    const echo = await yurt.exec("echo shell-only");
    const shown = (sel: string) => {
      const el = document.querySelector<HTMLElement>(sel);
      return el !== null && el.offsetParent !== null;
    };
    return {
      statuses: (globalThis as { __statuses?: string[] }).__statuses ?? [],
      notebook: shown("#notebook"),
      agent: shown("#agent"),
      notebookLink: shown("[data-testid=choose-notebook]"),
      labLink: shown("[data-testid=choose-lab]"),
      tabletNote: shown("#mobile-note"),
      ipykernel: text(ps.stdout).includes("ipykernel"),
      echo: text(echo.stdout).trim(),
      booting: sessionStorage.getItem("yurt-playground-booting"),
    };
  });
  const problems = [
    state.statuses.some((s) => s.includes("Jupyter")) &&
    `status mentioned Jupyter: ${JSON.stringify(state.statuses)}`,
    state.notebook && "Python pane shown",
    state.agent && "agent pane shown",
    state.notebookLink && "Notebook link shown",
    state.labLink && "JupyterLab link shown",
    !state.tabletNote && "tablet note hidden",
    state.ipykernel && "ipykernel is running",
    state.echo !== "shell-only" && `shell answered ${state.echo}`,
    state.booting !== null && `boot memory left: ${state.booting}`,
  ].filter(Boolean);
  if (problems.length > 0) {
    throw new Error(`tablet shell-only: ${problems.join("; ")}`);
  }
  await context.close();
}

/** The agent pane on a phone (#197): the page refuses the boot, so there is
 * no sandbox for the agent's Run to start, and the pane says so instead of
 * offering a download and a Run that does nothing. `?start-anyway` gets the
 * sandbox's Start, and with it the agent's. WebGPU is stubbed: headless
 * Chromium has none, and without it the pane never offers a Run anyway. */
export async function phoneAgentIsUnavailable(
  browser: Awaited<ReturnType<typeof chromium.launch>>,
  url: string,
): Promise<void> {
  const phone = await browser.newContext(devices["iPhone 13"]);
  await phone.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, "gpu", {
      configurable: true,
      get: () => ({ requestAdapter: () => Promise.resolve({}) }),
    });
  });
  const page = await phone.newPage();
  const agent = () =>
    page.evaluate(() => {
      const q = (id: string) =>
        document.querySelector<HTMLElement>(`[data-testid=${id}]`);
      return {
        shown: document.querySelector<HTMLElement>("#agent")!
          .offsetParent !== null,
        status: q("agent-status")?.textContent ?? null,
        unavailable: q("agent-unavailable") !== null,
        start: q("agent-start") !== null,
        run: q("agent-run") !== null,
      };
    });
  await page.goto(`${url}/?start`, { waitUntil: "domcontentloaded" });
  await page.getByTestId("boot-failed").waitFor({ state: "visible" });
  await page.getByTestId("agent-status").waitFor({ state: "visible" });
  const refused = await agent();
  const want = {
    shown: true,
    status: "not on phones",
    unavailable: true,
    start: false,
    run: false,
  };
  if (JSON.stringify(refused) !== JSON.stringify(want)) {
    throw new Error(
      `phone agent: want ${JSON.stringify(want)}, got ${
        JSON.stringify(refused)
      }`,
    );
  }
  await page.goto(`${url}/?start-anyway`, { waitUntil: "domcontentloaded" });
  await page.getByTestId("agent-start").waitFor({ state: "visible" });
  const anyway = await agent();
  if (anyway.unavailable || !anyway.run) {
    throw new Error(`phone agent ?start-anyway: ${JSON.stringify(anyway)}`);
  }
  await phone.close();
}

/** iPadOS Safari asks for the desktop site: its UA is a Mac Safari's. */
const IPADOS_SAFARI_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15";

/** Android Chrome's "Desktop site" UA: a Linux desktop's, no "Android". */
const ANDROID_DESKTOP_SITE_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

/** What the page knows before and after a boot it could not finish: a phone
 * is not offered Start (an iPhone was reloaded at "starting Jupyter"), and
 * says so as a refusal, not a failure, unless `?start-anyway`; a boot
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
  // iPhone Safari with "Request Desktop Website" sends the Mac Safari UA,
  // reports 5 touch points like an iPad, and lays out at 980 px; only its
  // screen, 390 px wide, says phone (#214).
  const desktopModeIPhone = await browser.newContext({
    userAgent: IPADOS_SAFARI_UA,
    viewport: { width: 980, height: 1700 },
    screen: { width: 390, height: 844 },
    hasTouch: true,
  });
  const desktopModePage = await desktopModeIPhone.newPage();
  await desktopModePage.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, "maxTouchPoints", {
      get: () => 5,
    });
  });
  await desktopModePage.goto(`${url}/?start`, {
    waitUntil: "domcontentloaded",
  });
  await failed(desktopModePage);
  expectPane(
    "iPhone Safari, desktop website",
    await readFailurePane(desktopModePage),
    {
      status: "not on phones",
      title: "The sandbox does not run on phones",
      notebook: "not on phones",
      start: true,
      why: ["phone"],
      reason: null,
    },
  );
  await desktopModeIPhone.close();

  // Android Chrome's "Desktop site" sends a Linux desktop UA and
  // `userAgentData.mobile` false, and ignores the viewport meta tag, so it
  // lays out at 980 px; its screen and coarse pointer are the phone's
  // (Chromium: ContentUtils SetUserAgentOverride, #216).
  const desktopSiteAndroid = await browser.newContext({
    userAgent: ANDROID_DESKTOP_SITE_UA,
    viewport: { width: 980, height: 2180 },
    screen: { width: 412, height: 915 },
    hasTouch: true,
  });
  const desktopSitePage = await desktopSiteAndroid.newPage();
  await desktopSitePage.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, "maxTouchPoints", {
      get: () => 5,
    });
    Object.defineProperty(Navigator.prototype, "userAgentData", {
      get: () => ({ mobile: false, platform: "Linux", brands: [] }),
    });
  });
  await desktopSitePage.goto(`${url}/?start`, {
    waitUntil: "domcontentloaded",
  });
  await failed(desktopSitePage);
  expectPane(
    "Android Chrome, desktop site",
    await readFailurePane(desktopSitePage),
    {
      status: "not on phones",
      title: "The sandbox does not run on phones",
      notebook: "not on phones",
      start: true,
      why: ["phone"],
      reason: null,
    },
  );
  await desktopSiteAndroid.close();

  const phone = await browser.newContext(devices["iPhone 13"]);
  const phonePage = await phone.newPage();
  await phonePage.goto(`${url}/?start`, { waitUntil: "domcontentloaded" });
  await failed(phonePage);
  expectPane("phone", await readFailurePane(phonePage), {
    status: "not on phones",
    title: "The sandbox does not run on phones",
    notebook: "not on phones",
    start: true,
    why: ["phone"],
    reason: null,
  });
  // `?start-anyway`: the same phone gets the Start button and no refusal.
  await phonePage.goto(`${url}/?start-anyway`, {
    waitUntil: "domcontentloaded",
  });
  await phonePage.getByTestId("start-sandbox").waitFor({ state: "visible" });
  const anyway = await phonePage.evaluate(() => ({
    failed: document.querySelector<HTMLElement>("#failed")!.hidden,
    notebook: document.querySelector("#notebook-status")!.textContent,
  }));
  if (!anyway.failed || anyway.notebook !== "waiting for the sandbox") {
    throw new Error(`phone ?start-anyway: ${JSON.stringify(anyway)}`);
  }
  await phone.close();

  const reason = "fetch ./yurt_kernel.wasm failed: 503";
  const scenes = [
    { name: "tablet", tablet: true, ...devices["iPad Pro 11"] },
    // What a real iPad sends: iPadOS Safari asks for the desktop site, so
    // its UA is a Mac's, and in landscape it is wider than any phone-sized
    // cutoff. Only its touch points tell it from a Mac (#195). Playwright's
    // iPad descriptor says "iPad" and would not catch this.
    {
      name: "iPadOS Safari, landscape",
      tablet: true,
      userAgent: IPADOS_SAFARI_UA,
      viewport: { width: 1194, height: 834 },
      // iOS reports the portrait screen in either orientation.
      screen: { width: 834, height: 1194 },
      hasTouch: true,
      maxTouchPoints: 5,
    },
    // The narrowest iPad, at 744 px, is still not a phone (an iPhone's
    // screen is 440 px at most).
    {
      name: "iPadOS Safari, iPad mini",
      tablet: true,
      userAgent: IPADOS_SAFARI_UA,
      viewport: { width: 744, height: 1133 },
      screen: { width: 744, height: 1133 },
      hasTouch: true,
      maxTouchPoints: 5,
    },
    // An Android tablet in Chrome's "Desktop site", which Chrome turns on
    // by default on large tablets: the phone's override (#216), but with a
    // tablet's screen. Only `navigator.platform` still says Android: Chrome
    // reports its reduced "Linux armv81" whatever the UA override (#217).
    {
      name: "Android Chrome, desktop site, tablet",
      tablet: true,
      userAgent: ANDROID_DESKTOP_SITE_UA,
      viewport: { width: 1280, height: 800 },
      screen: { width: 1280, height: 800 },
      hasTouch: true,
      maxTouchPoints: 10,
      platform: "Linux armv81",
    },
    { name: "desktop", tablet: false },
    // The same screen, touch and UA on a Linux PC (a touchscreen laptop
    // with touch as its primary pointer) is a desktop: Chrome on Linux
    // reports "Linux x86_64" (#217).
    {
      name: "Linux Chrome, touchscreen",
      tablet: false,
      userAgent: ANDROID_DESKTOP_SITE_UA,
      viewport: { width: 1280, height: 800 },
      screen: { width: 1280, height: 800 },
      hasTouch: true,
      maxTouchPoints: 10,
      platform: "Linux x86_64",
    },
    // A phone-sized screen alone is not a phone: the small-screen rule for
    // Android's "Desktop site" also needs a coarse pointer (#216).
    {
      name: "small screen, fine pointer",
      tablet: false,
      viewport: { width: 980, height: 2180 },
      screen: { width: 412, height: 915 },
    },
    // The same UA without touch is a Mac, whatever the CI runner's OS.
    {
      name: "Mac Safari",
      tablet: false,
      userAgent: IPADOS_SAFARI_UA,
      viewport: { width: 1194, height: 834 },
    },
    // A Mac under DevTools touch emulation reports one touch point: still a
    // Mac (an iPad reports 5).
    {
      name: "Mac Safari, emulated touch",
      tablet: false,
      userAgent: IPADOS_SAFARI_UA,
      viewport: { width: 1194, height: 834 },
      hasTouch: true,
    },
  ];
  for (
    const { name, tablet, maxTouchPoints, platform, ...options } of scenes
  ) {
    const context = await browser.newContext(options);
    const page = await context.newPage();
    // Chromium's touch emulation reports one touch point; an iPad reports 5.
    if (maxTouchPoints !== undefined) {
      await page.addInitScript((points) => {
        Object.defineProperty(Navigator.prototype, "maxTouchPoints", {
          get: () => points,
        });
      }, maxTouchPoints);
    }
    // Headless Chromium reports the runner's own platform.
    if (platform !== undefined) {
      await page.addInitScript((value) => {
        Object.defineProperty(Navigator.prototype, "platform", {
          get: () => value,
        });
      }, platform);
    }
    await page.route(
      "**/yurt_kernel.wasm",
      (route) => route.fulfill({ status: 503 }),
    );
    await page.goto(`${url}/?start`, { waitUntil: "domcontentloaded" });
    await failed(page);
    expectPane(name, await readFailurePane(page), {
      status: "failed",
      title: "The sandbox did not start",
      notebook: "no sandbox",
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
    title: "The sandbox did not start",
    notebook: "no sandbox",
    start: true,
    why: ["reloaded"],
    reason: "starting Jupyter",
  });
  // Explained once; the next visit is a fresh Start.
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByTestId("start-sandbox").waitFor({ state: "visible" });
  await context.close();
}

type Exec = { code: number | null; stdout: string; stderr: string };

function exec(page: Page, cmd: string): Promise<Exec> {
  return page.evaluate(
    (cmd) =>
      (globalThis as unknown as {
        yurt: { exec(cmd: string): Promise<Exec> };
      }).yurt.exec(cmd),
    cmd,
  );
}

/**
 * "Packages": install a package through the real control and run it. The
 * page downloads; the guest's own `pkg` verifies and installs
 * (src/packages.ts). Skipped on an image without `pkg` (before the modular
 * base image).
 *
 * PLAYGROUND_PKG_NAME (default `yurt-greet`) is the package and
 * PLAYGROUND_PKG_RUN (default its name) the command that must then exit 0.
 * PLAYGROUND_PKG_REPO=<dir> answers the page's repository requests from a
 * local directory in the repository's layout, instead of YurtOS/yurt-packages;
 * the guest's `pkg` still verifies what it is given.
 */
async function packagesInstallAndRun(page: Page): Promise<void> {
  const name = Deno.env.get("PLAYGROUND_PKG_NAME") ?? "yurt-greet";
  const run = Deno.env.get("PLAYGROUND_PKG_RUN") ?? name;
  const localRepo = Deno.env.get("PLAYGROUND_PKG_REPO");
  const image = await exec(
    page,
    "command -v pkg && command -v sudo && test -r /etc/yurt-pkg/trusted-repos.toml",
  );
  if (image.code !== 0) {
    console.log(
      "playground e2e: Packages SKIPPED, the image has no pkg or sudo",
    );
    return;
  }
  if (localRepo !== undefined) {
    await page.route(`${PACKAGE_REPO_URL}**`, async (route) => {
      const path = route.request().url().slice(PACKAGE_REPO_URL.length);
      try {
        await route.fulfill({
          body: Buffer.from(await Deno.readFile(join(localRepo, path))),
          headers: { "access-control-allow-origin": "*" },
        });
      } catch {
        await route.fulfill({ status: 404 });
      }
    });
  }
  const before = await exec(page, `command -v ${run.split(" ")[0]}`);
  if (before.code === 0) {
    throw new Error(`packages: ${run} is there before the install`);
  }
  await page.getByTestId("packages-toggle").click();
  const install = page.locator(
    `[data-testid=packages-list] button[data-package="${name}"]`,
  );
  await install.waitFor({ timeout: 60_000 });
  await install.click();
  await page.waitForFunction(
    () => {
      const state = document.querySelector<HTMLElement>("#packages")
        ?.dataset.install;
      return state === "done" || state === "failed";
    },
    undefined,
    { timeout: 300_000 },
  );
  const status = await page.getByTestId("packages-status").textContent();
  if (status !== `installed ${name}`) {
    throw new Error(`packages: install ${name}: ${status}`);
  }
  const listed = await exec(page, "sudo pkg list");
  if (!listed.stdout.split("\n").some((line) => line.startsWith(`${name} `))) {
    throw new Error(
      `packages: sudo pkg list lacks ${name}: ${JSON.stringify(listed)}`,
    );
  }
  const ran = await exec(page, run);
  if (ran.code !== 0) {
    throw new Error(
      `packages: ${run} after the install: ${JSON.stringify(ran)}`,
    );
  }
  console.log(
    `playground e2e: Packages installed ${name}; \`${run}\` printed ${
      JSON.stringify(ran.stdout.trim().split("\n")[0])
    }`,
  );
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
    // A cell that takes its time shows what it has printed while it runs,
    // and Stop ends it: before #130/#131 the pane was blank for the whole
    // of a cell and a loop cost the reader the boot (reload was the only
    // way out).
    await page.getByTestId("notebook-input").fill(
      "import time\nfor i in range(600):\n" +
        "    print('tick', i, flush=True)\n    time.sleep(0.2)",
    );
    await page.getByTestId("notebook-execute").click();
    await page.waitForFunction(
      () => {
        const out = document.querySelector<HTMLElement>(
          "[data-testid=notebook-output]",
        )?.textContent ?? "";
        const status = document.querySelector<HTMLElement>(
          "[data-testid=notebook-status]",
        )?.textContent ?? "";
        return status !== "ok" && out.includes("tick 0");
      },
      undefined,
      { timeout: 90_000 },
    );
    console.log("playground e2e: the cell streamed while it ran");
    await page.getByTestId("notebook-interrupt").click();
    await page.waitForFunction(
      () =>
        (document.querySelector<HTMLElement>(
          "[data-testid=notebook-output]",
        )?.textContent ?? "").includes("KeyboardInterrupt"),
      undefined,
      {
        timeout: 90_000,
      },
    );
    // ... and the cell is the reader's again.
    await page.waitForFunction(() =>
      document.querySelector<HTMLButtonElement>(
          "[data-testid=notebook-execute]",
        )?.disabled === false &&
      document.querySelector<HTMLElement>(
          "[data-testid=notebook-interrupt]",
        )?.hidden === true
    );
    console.log(
      "playground e2e: Stop raised KeyboardInterrupt and gave the cell back",
    );
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
          spawn(cmd: string): Promise<{
            kill(signal?: string): Promise<void>;
            wait(): Promise<Record<string, unknown>>;
          }>;
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
      // yurtos-kernel#3611: `pip` is a `#!/usr/local/bin/python3` script the
      // image records 0755; staged with the ramfs default 0644, exec failed
      // with "Permission denied".
      const pip = await y.exec("ls -l /usr/local/bin/pip; pip --version");
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
      // #204: the guest's wait status, not what the page did. An exit is a
      // code; a signal death is a signal whoever sent it, never 128+n; and
      // a handler that exits 130 is code 130, the page's SIGINT included.
      const exit3 = await y.exec("exit 3");
      const termed = await y.exec("kill -TERM $$");
      const handled = await y.exec(
        "trap 'exit 130' INT; kill -INT $$; sleep 5; exit 1",
      );
      const trapping = await y.spawn(
        "trap 'exit 130' INT; while :; do sleep 0.1; done",
      );
      await new Promise((r) => setTimeout(r, 1000));
      await trapping.kill("SIGINT");
      const interrupted = await trapping.wait();
      const waited = (r: Record<string, unknown>) => ({
        code: r.code,
        signal: r.signal,
      });
      const ended = {
        exit3: waited(exit3),
        termed: waited(termed),
        handled: waited(handled),
        interrupted: waited(interrupted),
      };
      return {
        ended,
        status,
        attr,
        both,
        pip,
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
      "the image's pip launcher execs (yurtos-kernel#3611)",
      driven.pip.code === 0 &&
        /^-rwxr-xr-x\s/.test(driven.pip.stdout as string) &&
        (driven.pip.stdout as string).includes("\npip "),
      driven.pip,
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
    const ended = (got: unknown, code: number | null, signal: string | null) =>
      JSON.stringify(got) === JSON.stringify({ code, signal });
    expect(
      "wait status (#204)",
      ended(driven.ended.exit3, 3, null) &&
        ended(driven.ended.termed, null, "SIGTERM") &&
        ended(driven.ended.handled, 130, null) &&
        ended(driven.ended.interrupted, 130, null),
      driven.ended,
    );
    console.log(
      `playground e2e: window.yurt drove the sandbox (timeout in ${driven.ms} ms)`,
    );
    // #81: "Download home" saves /home/user as a gzipped tar made by a
    // process of its own -- while the shell is busy with something else.
    await page.evaluate(() =>
      (globalThis as unknown as {
        yurt: { spawn(cmd: string): Promise<{ id: string }> };
      }).yurt.spawn("sleep 30")
    );
    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 60_000 }).catch(async (e) => {
        throw new Error(
          `${e}; status=${await page.locator("#status").textContent()}`,
        );
      }),
      page.getByTestId("export-home").click(),
    ]);
    if (download.suggestedFilename() !== "user.tgz") {
      throw new Error(
        `export saved ${download.suggestedFilename()}, not user.tgz`,
      );
    }
    const archive = await Deno.readFile(await download.path());
    if (archive[0] !== 0x1f || archive[1] !== 0x8b) {
      throw new Error("the exported home is not a gzip");
    }
    const listing = new Deno.Command("tar", {
      args: ["-tzf", await download.path()],
    })
      .outputSync();
    const names = new TextDecoder().decode(listing.stdout);
    if (!names.includes("user/drv.txt")) {
      throw new Error(
        `the exported home lacks the file written earlier:\n${names}`,
      );
    }
    console.log(
      `playground e2e: Download home saved ${archive.byteLength} bytes`,
    );
    // "Upload": files from this device into /home/user through the real
    // control. A #! script comes in executable, a plain file does not, and
    // a few MB arrive intact (the in-tab write streams them through stdin).
    const big = new Uint8Array(3 * 1024 * 1024);
    for (let i = 0; i < big.length; i++) big[i] = (i * 7 + 3) & 0xff;
    await page.getByTestId("upload-input").setInputFiles([
      {
        name: "hi.sh",
        mimeType: "text/x-sh",
        buffer: Buffer.from(new TextEncoder().encode(
          "#!/bin/sh\necho uploaded-script-ran\n",
        )),
      },
      {
        name: "notes.txt",
        mimeType: "text/plain",
        buffer: Buffer.from(new TextEncoder().encode("plain\n")),
      },
      {
        name: "big.bin",
        mimeType: "application/octet-stream",
        buffer: Buffer.from(big),
      },
    ]);
    await page.waitForFunction(
      () =>
        document.querySelector("#status")?.textContent?.startsWith(
          "uploaded 3 files",
        ),
      undefined,
      { timeout: 60_000 },
    ).catch(async (e) => {
      throw new Error(
        `${e}; status=${await page.locator("#status").textContent()}`,
      );
    });
    const uploaded = await page.evaluate(() =>
      (globalThis as unknown as {
        yurt: { exec(cmd: string): Promise<{ code: number; stdout: string }> };
      }).yurt.exec(
        "cd /home/user && ./hi.sh && wc -c < big.bin && sha256sum big.bin && [ -x notes.txt ] && echo notes-executable || echo notes-plain",
      )
    );
    // The bytes too, not only their count: a transport that kept the length
    // but changed bytes (line-discipline mangling) would pass a size check.
    const bigSha = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", big)),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    if (
      uploaded.code !== 0 ||
      uploaded.stdout.trim().split("\n").join(" ") !==
        `uploaded-script-ran ${big.length} ${bigSha}  big.bin notes-plain`
    ) {
      throw new Error(`upload: ${JSON.stringify(uploaded)}`);
    }
    console.log(`playground e2e: Upload wrote 3 files (${big.length} bytes)`);
    await packagesInstallAndRun(page);
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
    await tabletIsShellOnly(browser, server.url);
    await phoneAgentIsUnavailable(browser, server.url);
  } finally {
    await browser.close();
    await server.shutdown();
  }
}
