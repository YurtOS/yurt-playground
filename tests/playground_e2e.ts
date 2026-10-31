import { chromium, devices, type Page } from "playwright";
import { Buffer } from "node:buffer";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureBundle } from "../scripts/serve.ts";
import { startPlaygroundServer } from "../src/serve.ts";
import { EXECUTE_TIMEOUT_MS } from "../src/jupyter_protocol.ts";
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
  await touchKeysWork(page);
  await context.close();
}

/** The terminal's key bar on a touch device (#273): iOS gives xterm's hidden
 * textarea no paste menu, and the iPhone and iPad keyboards have no arrow
 * keys. `page` shows a running shell on an emulated touch device. ↑ and ↓
 * walk ash's history, ← and → move the cursor along the line, Paste puts
 * the clipboard on the command line, a refused or empty clipboard is said in
 * the bar, and the terminal keeps the focus (the iOS keyboard) through every
 * tap. The clipboard is stubbed: neither headless
 * engine has one a test can fill and read the same way. */
export async function touchKeysWork(page: Page): Promise<void> {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  const bar = page.getByTestId("term-keys");
  if (!(await bar.isVisible())) throw new Error("touch key bar not shown");
  const fits = await bar.evaluate((el) => el.scrollWidth <= el.clientWidth);
  if (!fits) throw new Error("touch key bar overflows its width");
  /** The terminal's lines, trimmed; the last non-empty one is the prompt. */
  const lines = () =>
    page.evaluate(() =>
      Array.from(
        document.querySelectorAll("#term .xterm-rows > div"),
        (row) => (row.textContent ?? "").replace(/ /g, " ").trim(),
      ).filter((line) => line !== "")
    );
  const waitFor = async (what: string, ok: (lines: string[]) => boolean) => {
    const deadline = Date.now() + 30_000;
    let seen = await lines();
    while (!ok(seen)) {
      if (Date.now() > deadline) {
        throw new Error(`touch keys: ${what}; terminal: ${seen.join(" | ")}`);
      }
      await page.waitForTimeout(100);
      seen = await lines();
    }
  };
  const count = (seen: string[], line: string) =>
    seen.filter((l) => l === line).length;
  const promptShows = (command: string) =>
    waitFor(
      `prompt shows "${command}"`,
      (seen) => seen.at(-1)?.endsWith(command) === true,
    );
  const focused = async (after: string) => {
    const ok = await page.evaluate(() =>
      document.activeElement?.classList.contains("xterm-helper-textarea")
    );
    if (!ok) throw new Error(`terminal lost the focus after ${after}`);
  };
  const tap = async (key: string) => {
    await page.getByTestId(`term-key-${key}`).tap();
    await focused(`tapping ${key}`);
  };
  const clipboard = (text: string | null) =>
    page.evaluate((text) => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          readText: () =>
            text === null
              ? Promise.reject(new DOMException("denied", "NotAllowedError"))
              : Promise.resolve(text),
        },
      });
    }, text);

  // Input sent before ash reads its next line is echoed raw (^[[A), so
  // each step waits for the bare prompt.
  const prompt = () =>
    waitFor("prompt", (seen) => /^\S*[$#]$/.test(seen.at(-1) ?? ""));

  await page.locator("#term").tap();
  await prompt();
  await page.keyboard.type("echo keys-one\n");
  await waitFor("first command ran", (seen) => count(seen, "keys-one") === 1);
  await prompt();
  await page.keyboard.type("echo keys-two\n");
  await waitFor("second command ran", (seen) => count(seen, "keys-two") === 1);
  await prompt();
  await tap("up");
  await promptShows("echo keys-two");
  await tap("up");
  await promptShows("echo keys-one");
  await tap("down");
  await promptShows("echo keys-two");
  await page.keyboard.press("Enter");
  await waitFor(
    "recalled command ran",
    (seen) => count(seen, "keys-two") === 2,
  );

  // ← then a letter inserts before the line's last character, → moves back
  // past it: "keys-a" becomes "keys-bac".
  await prompt();
  await page.keyboard.type("echo keys-a");
  await promptShows("echo keys-a");
  await tap("left");
  await page.keyboard.type("b");
  await promptShows("echo keys-ba");
  await tap("right");
  await page.keyboard.type("c");
  await promptShows("echo keys-bac");
  await page.keyboard.press("Enter");
  await waitFor("edited command ran", (seen) => count(seen, "keys-bac") === 1);

  await prompt();
  await clipboard("echo keys-pasted");
  await tap("paste");
  await promptShows("echo keys-pasted");
  await page.keyboard.press("Enter");
  await waitFor(
    "pasted command ran",
    (seen) => count(seen, "keys-pasted") === 1,
  );

  const note = page.getByTestId("term-key-note");
  for (const [text, says] of [[null, "clipboard"], ["", "empty"]] as const) {
    await clipboard(text);
    await tap("paste");
    await page.waitForFunction(
      (says) =>
        document.querySelector("[data-testid=term-key-note]")?.textContent
          ?.includes(says),
      says,
      { timeout: 5_000 },
    ).catch(async () => {
      throw new Error(
        `touch keys: paste of ${JSON.stringify(text)} said "${await note
          .textContent()}"`,
      );
    });
  }
  if (errors.length > 0) {
    throw new Error(`touch keys: page errors ${errors.join("; ")}`);
  }
  console.log(
    "playground e2e: touch keys recall, move, paste and keep the focus",
  );
}

/** The agent pane on a phone (#197): a phone boots now (its own small
 * snapshot), so the pane offers the sandbox's Start and the agent's Run,
 * as on a tablet. WebGPU is stubbed: headless Chromium has none, and
 * without it the pane never offers a Run anyway. */
export async function phoneAgentHasTheSandbox(
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
  await page.goto(`${url}/`, { waitUntil: "domcontentloaded" });
  await page.getByTestId("agent-start").waitFor({ state: "visible" });
  const agent = await page.evaluate(() => {
    const q = (id: string) =>
      document.querySelector<HTMLElement>(`[data-testid=${id}]`);
    return {
      unavailable: q("agent-unavailable") !== null,
      run: q("agent-run") !== null,
      start: (q("start-sandbox")?.offsetParent ?? null) !== null,
      platform: new URL(location.href).searchParams.get("platform"),
    };
  });
  if (
    agent.unavailable || !agent.run || !agent.start ||
    agent.platform !== "phone"
  ) {
    throw new Error(`phone agent: ${JSON.stringify(agent)}`);
  }
  await phone.close();
}

/** iPadOS Safari asks for the desktop site: its UA is a Mac Safari's. */
const IPADOS_SAFARI_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15";

/** Android Chrome's "Desktop site" UA: a Linux desktop's, no "Android". */
const ANDROID_DESKTOP_SITE_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

/** What the page knows before and after a boot it could not finish: each
 * device is told apart and its platform written into the URL (a phone, a
 * tablet, a desktop; a hand-written `?platform=` kept); a boot that dies
 * in-page explains itself in the terminal's place, with the likely cause on
 * a tablet; and a tab the browser reloaded mid-boot says so on the next
 * load instead of offering a fresh Start. */
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
  const reason = "fetch ./yurt_kernel.wasm failed: 503";
  // Phones: each one is told apart from a tablet or a desktop, and the bare
  // URL gains `platform=phone` before anything loads. A phone now boots,
  // the shell only (its own small snapshot, or the image): a failed boot
  // explains itself as on any device, and the cell says no Jupyter here.
  const phones: {
    name: string;
    options: Parameters<typeof browser.newContext>[0];
    init?: () => void;
  }[] = [
    // iPhone Safari with "Request Desktop Website" sends the Mac Safari UA,
    // reports 5 touch points like an iPad, and lays out at 980 px; only its
    // screen, 390 px wide, says phone (#214).
    {
      name: "iPhone Safari, desktop website",
      options: {
        userAgent: IPADOS_SAFARI_UA,
        viewport: { width: 980, height: 1700 },
        screen: { width: 390, height: 844 },
        hasTouch: true,
      },
      init: () =>
        Object.defineProperty(Navigator.prototype, "maxTouchPoints", {
          get: () => 5,
        }),
    },
    // Android Chrome's "Desktop site" sends a Linux desktop UA and
    // `userAgentData.mobile` false, and ignores the viewport meta tag, so it
    // lays out at 980 px; its screen and coarse pointer are the phone's
    // (Chromium: ContentUtils SetUserAgentOverride, #216).
    {
      name: "Android Chrome, desktop site",
      options: {
        userAgent: ANDROID_DESKTOP_SITE_UA,
        viewport: { width: 980, height: 2180 },
        screen: { width: 412, height: 915 },
        hasTouch: true,
      },
      init: () => {
        Object.defineProperty(Navigator.prototype, "maxTouchPoints", {
          get: () => 5,
        });
        Object.defineProperty(Navigator.prototype, "userAgentData", {
          get: () => ({ mobile: false, platform: "Linux", brands: [] }),
        });
      },
    },
    { name: "phone", options: devices["iPhone 13"] },
  ];
  for (const { name, options, init } of phones) {
    const context = await browser.newContext(options);
    const page = await context.newPage();
    if (init !== undefined) await page.addInitScript(init);
    await page.route(
      "**/yurt_kernel.wasm",
      (route) => route.fulfill({ status: 503 }),
    );
    await page.goto(`${url}/?start`, { waitUntil: "domcontentloaded" });
    await failed(page);
    const seen = await page.evaluate(() => ({
      platform: new URL(location.href).searchParams.get("platform"),
      data: document.documentElement.dataset.platform,
      note: !document.querySelector<HTMLElement>("#phone-note")!.hidden,
    }));
    if (seen.platform !== "phone" || seen.data !== "phone" || !seen.note) {
      throw new Error(`${name}: ${JSON.stringify(seen)}`);
    }
    expectPane(name, await readFailurePane(page), {
      status: "failed",
      title: "The sandbox did not start",
      notebook: "no sandbox",
      start: true,
      why: ["error"],
      reason,
    });
    await context.close();
  }

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
    // The bare URL gains the device's platform.
    const want = tablet ? "tablet" : "desktop";
    const seen = await page.evaluate(() => [
      new URL(location.href).searchParams.get("platform"),
      new URL(location.href).searchParams.has("start"),
      document.documentElement.dataset.platform,
    ]);
    if (seen[0] !== want || seen[1] !== true || seen[2] !== want) {
      throw new Error(`${name}: platform ${JSON.stringify(seen)}, not ${want}`);
    }
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

  // `?platform=` by hand: a smaller platform is run as asked (a desktop
  // trying the phone's page), a bigger one than the device runs the
  // device's own and says so; neither is written away from the URL.
  for (
    const [name, options, asked, want, noted] of [
      ["desktop as a phone", {}, "phone", "phone", false],
      ["phone as a desktop", devices["iPhone 13"], "desktop", "phone", true],
      [
        "tablet as a desktop",
        devices["iPad Pro 11"],
        "desktop",
        "tablet",
        true,
      ],
    ] as const
  ) {
    const context = await browser.newContext(options);
    const page = await context.newPage();
    await page.goto(`${url}/?platform=${asked}`, {
      waitUntil: "domcontentloaded",
    });
    await page.getByTestId("start-sandbox").waitFor({ state: "visible" });
    const seen = await page.evaluate(() => ({
      url: new URL(location.href).searchParams.get("platform"),
      data: document.documentElement.dataset.platform,
      note: !document.querySelector<HTMLElement>("#platform-note")!.hidden,
    }));
    if (seen.url !== asked || seen.data !== want || seen.note !== noted) {
      throw new Error(`${name}: ${JSON.stringify(seen)}`);
    }
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

/** A snapshot of YurtOS/yurt-packages as published at fa6ce22 (2026-10-25):
 * the signed index, its bundle and every package's metadata, no archives.
 * Its bundles are the repository's placeholder text, so the guest's `pkg`
 * must refuse it; the signature check comes before the expiry check, so
 * the outcome does not depend on the date. */
const PACKAGES_SNAPSHOT = join(repoRoot, "tests/fixtures/yurt-packages");

/**
 * "Packages": install through the real control and check what the guest's
 * `pkg` made of it (src/packages.ts). Skipped on an image without `pkg` and
 * `sudo` (before the modular base image).
 *
 * By default the page's repository requests are answered from
 * PACKAGES_SNAPSHOT, and the install must fail closed: no network, and a
 * result that does not change when the live repository is republished.
 * PLAYGROUND_PKG_REPO=<dir> answers from another directory in the
 * repository's layout instead, and PLAYGROUND_PKG_LIVE=1 from the live
 * repository; both expect PLAYGROUND_PKG_NAME to install and
 * PLAYGROUND_PKG_RUN (default its name) to exit 0 after. The name defaults
 * to `yurt-greet`, the snapshot's package, and to `rtk` (run as
 * `rtk --version`) against the live repository, which no longer publishes
 * yurt-greet.
 */
async function packagesInstall(page: Page): Promise<void> {
  const live = Deno.env.get("PLAYGROUND_PKG_LIVE") === "1";
  const name = Deno.env.get("PLAYGROUND_PKG_NAME") ??
    (live ? "rtk" : "yurt-greet");
  const run = Deno.env.get("PLAYGROUND_PKG_RUN") ??
    (live && name === "rtk" ? "rtk --version" : name);
  const repo = Deno.env.get("PLAYGROUND_PKG_REPO");
  const expectInstall = live || repo !== undefined;
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
  if (!live) {
    const dir = repo ?? PACKAGES_SNAPSHOT;
    // Nothing reaches GitHub: a file the directory lacks, or any other
    // request to the host, is a 404.
    // The coordinator Worker fetches the repository: a context route sees
    // a dedicated worker's requests, a page route does not.
    await page.context().route(
      "https://raw.githubusercontent.com/**",
      async (route) => {
        const url = route.request().url();
        try {
          if (!url.startsWith(PACKAGE_REPO_URL)) throw new Error(url);
          await route.fulfill({
            body: Buffer.from(
              await Deno.readFile(
                join(dir, url.slice(PACKAGE_REPO_URL.length)),
              ),
            ),
            headers: { "access-control-allow-origin": "*" },
          });
        } catch {
          await route.fulfill({ status: 404 });
        }
      },
    );
  }
  const command = run.split(" ")[0];
  const before = await exec(page, `command -v ${command}`);
  if (before.code === 0) {
    throw new Error(`packages: ${command} is there before the install`);
  }
  await page.getByTestId("packages-toggle").click();
  const install = page.locator(
    `[data-testid=packages-list] button[data-package="${name}"]`,
  );
  await install.waitFor({ timeout: 60_000 });
  // The image bakes zsh into its base outside pkg, which refuses to
  // install over it ("would overwrite unmanaged path bin/zsh"): the panel
  // leaves it out, and the remark above the terminal names it. python-seal
  // is left out by name (src/packages.ts NOT_LISTED).
  const zsh = await exec(page, "test -e /bin/zsh && sudo pkg list");
  if (zsh.code === 0 && !/^zsh /m.test(zsh.stdout)) {
    const seen = await page.evaluate(() => {
      const listed = (name: string) => {
        const row = document.querySelector<HTMLElement>(
          `[data-testid=packages-list] tr[data-package="${name}"]`,
        );
        return row === null ? null : row.checkVisibility();
      };
      return {
        zsh: listed("zsh"),
        pythonSeal: listed("python-seal"),
        yurtGreet: listed("yurt-greet"),
        remark: document.querySelector("#linux-remark-text")?.textContent ??
          "",
      };
    });
    if (
      seen.zsh !== false || seen.pythonSeal === true ||
      (!live && seen.yurtGreet !== true) || !/; also zsh\b/.test(seen.remark)
    ) {
      throw new Error(
        `packages: want zsh left out of the list and named in the remark, python-seal left out, got ${
          JSON.stringify(seen)
        }`,
      );
    }
    console.log(
      `playground e2e: Packages leaves zsh out; the remark says ${
        JSON.stringify(seen.remark)
      }`,
    );
  } else if (Deno.env.get("PLAYGROUND_REQUIRE_ARTIFACTS") === "1") {
    throw new Error(
      `packages: the pinned image should have an unmanaged /bin/zsh: ${
        JSON.stringify(zsh)
      }`,
    );
  }
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
  const state = await page.locator("#packages").getAttribute("data-install");
  const status = await page.getByTestId("packages-status").textContent() ??
    "";
  const listed = await exec(page, "sudo pkg list");
  const isListed = listed.stdout.split("\n").some((line) =>
    line.startsWith(`${name} `)
  );
  const after = await exec(page, `command -v ${command}`);
  const staging = await exec(
    page,
    "ls -A /var/cache/yurt-pkg/browser/staging 2>/dev/null",
  );
  if (staging.stdout.trim() !== "") {
    throw new Error(`packages: staging left behind: ${staging.stdout}`);
  }
  if (!expectInstall) {
    const problems = [
      state !== "failed" && `state ${state}`,
      !new RegExp(`^pkg install ${name} failed: .*verification failed`)
        .test(status) && `status ${JSON.stringify(status)}`,
      isListed && `sudo pkg list has ${name}`,
      after.code === 0 && `${command} is installed`,
    ].filter(Boolean);
    if (problems.length > 0) {
      throw new Error(
        `packages: the snapshot's placeholder signatures were not refused: ${
          problems.join("; ")
        }`,
      );
    }
    console.log(`playground e2e: Packages refused ${name}: ${status}`);
    return;
  }
  if (state !== "done" || status !== `installed ${name}` || !isListed) {
    throw new Error(
      `packages: install ${name}: ${state} ${status} ${JSON.stringify(listed)}`,
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

/** Type `line` into the terminal and wait for `marker` at the end of its
 * output; what the screen then shows. */
async function typeInTerminal(
  page: Page,
  line: string,
  timeout: number,
): Promise<string> {
  const marker = `__PKG_${crypto.randomUUID().slice(0, 8)}__`;
  await page.locator("#term").click();
  await page.keyboard.type(`clear; ${line}; echo ${marker}\n`);
  await page.waitForFunction(
    (marker) => {
      const rows = [
        ...document.querySelectorAll("#term .xterm-rows > div"),
      ].map((row) => row.textContent?.trim());
      return rows.includes(marker);
    },
    marker,
    { timeout },
  );
  return await page.locator("#term .xterm-rows").innerText();
}

/**
 * The terminal's own `pkg`, through the page's relay (src/pkg_relay.ts).
 * Against the repository snapshot (the default) `sudo pkg update` must get
 * the index through the relay and then refuse its placeholder signature:
 * before the relay it failed earlier, with no network ("HTTP request
 * failed"). With PLAYGROUND_PKG_LIVE=1 it must update from the live
 * repository, find the same index current a second time, and install
 * PLAYGROUND_PKG_TERMINAL_NAME (default pkgconf), which must then run.
 */
async function terminalPkg(page: Page): Promise<void> {
  const live = Deno.env.get("PLAYGROUND_PKG_LIVE") === "1";
  const update = await typeInTerminal(page, "sudo pkg update", 180_000);
  if (update.includes("HTTP request failed")) {
    throw new Error(`terminal pkg update had no network: ${update}`);
  }
  if (!live) {
    if (!/failed to update official/.test(update)) {
      throw new Error(`terminal pkg update: ${update}`);
    }
    console.log(
      "playground e2e: terminal pkg update reached the repository and refused its placeholder signature",
    );
    return;
  }
  if (!/updated official|official already current/.test(update)) {
    throw new Error(`terminal pkg update: ${update}`);
  }
  const again = await typeInTerminal(page, "sudo pkg update", 180_000);
  if (!again.includes("official already current")) {
    throw new Error(`terminal pkg update again: ${again}`);
  }
  const name = Deno.env.get("PLAYGROUND_PKG_TERMINAL_NAME") ?? "pkgconf";
  const install = await typeInTerminal(
    page,
    `sudo pkg install ${name} && ${name} --version && echo installed-ok`,
    300_000,
  );
  if (!install.includes("installed-ok")) {
    throw new Error(`terminal pkg install ${name}: ${install}`);
  }
  console.log(`playground e2e: terminal sudo pkg install ${name} worked`);
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
      // Since the slim image (2026.10.27) the page installs Python first:
      // ~83 s from page load to ready on an M-series laptop, and 116-284 s
      // for this scene on a CI runner (a first install there has reached
      // 310 s; job logs, 10-27/28), against which 300 s failed the scene at
      // random. The rest of the scene takes under a minute, inside the
      // acceptance step's 11 min cap.
      { timeout: 480_000 },
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
    await packagesInstall(page);
    await terminalPkg(page);
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
    // The touch key bar is for touch devices only (#273).
    if (await page.getByTestId("term-keys").count() !== 0) {
      throw new Error("a desktop page shows the touch key bar");
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
    await phoneAgentHasTheSandbox(browser, server.url);
  } finally {
    await browser.close();
    await server.shutdown();
  }
}
