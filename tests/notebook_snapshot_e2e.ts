/**
 * Browser acceptance for the suspend/resume notebook kernel: the
 * `suspend-resume.ipynb` notebook on the `yurt-snapshot` kernel prints
 * primes; the sandbox is sealed into IndexedDB every few seconds while the
 * cell runs, so closing the tab and reopening the notebook brings the same
 * cell back, continuing at the next prime (#109); then Suspend seals and
 * tears down by hand (the output stops) and Resume carries on.
 *
 * Run: deno run --allow-all tests/notebook_snapshot_e2e.ts (needs the pinned
 * blobs in artifacts/, public/demo/python3-seal.wasm from
 * scripts/install-pinned-artifacts.sh, and the site from jupyterlite/build.sh).
 * Skips without the CPython blob unless PLAYGROUND_REQUIRE_ARTIFACTS is set.
 *
 * On a site that pins a slim image the kernel runs the newest complete
 * Python set's python-seal instead, from the package repository (the live
 * one, or PLAYGROUND_SLIM_REPO=<dir> in the repository's layout). With
 * PLAYGROUND_SLIM_REPO_NEXT=<dir> (the same plus a newer complete set), the
 * scene then suspends, switches to it and reopens: the suspend was made on
 * the older set, so it is discarded, and the new session runs the cell from
 * its start on the newer set. With PLAYGROUND_SLIM_REPO_TAMPERED=<dir> (a set
 * whose python-seal archive matches its metadata but not its signature), it
 * first checks that the kernel refuses to start on it.
 */
import { chromium, type Page } from "playwright";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureBundle } from "../scripts/serve.ts";
import { PYTHON_SEAL_NAME } from "../src/image_parts.ts";
import { startPlaygroundServer } from "../src/serve.ts";
import { PACKAGE_REPO_URL } from "../src/packages.ts";
import { Buffer } from "node:buffer";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function fail(message: string): never {
  throw new Error(message);
}

/** The prime numbers printed so far by the notebook's first code cell. */
function primesPrinted(page: Page): Promise<number[]> {
  return page.evaluate(() => {
    const cell = document.querySelectorAll(".jp-CodeCell")[0];
    const text = cell?.querySelector(".jp-OutputArea")?.textContent ?? "";
    return [...text.matchAll(/prime #(\d+) = \d+/g)].map((m) => Number(m[1]));
  });
}

async function waitForPanelState(
  page: Page,
  state: string,
  timeout: number,
): Promise<void> {
  await page.waitForFunction(
    (want) =>
      document.querySelector<HTMLElement>(".yurt-snapshot-panel")?.dataset
        .state === want,
    state,
    { timeout },
  );
}

if (import.meta.main) {
  const pins = JSON.parse(
    await Deno.readTextFile(join(repoRoot, "artifacts/pins.json")),
  );
  const slim = pins.browserImage !== undefined;
  try {
    if (!slim) await Deno.stat(join(repoRoot, "public", PYTHON_SEAL_NAME));
  } catch {
    if (Deno.env.get("PLAYGROUND_REQUIRE_ARTIFACTS")) {
      fail(
        `${PYTHON_SEAL_NAME} is missing; run scripts/install-pinned-artifacts.sh`,
      );
    }
    console.log(`notebook snapshot e2e: skipped, no ${PYTHON_SEAL_NAME}`);
    Deno.exit(0);
  }
  await ensureBundle(
    Deno.env.get("YURT_KERNEL_ROOT") ?? join(repoRoot, "../yurtos-kernel"),
  );
  await Deno.stat(join(repoRoot, "public/jupyter/index.html")).catch(() =>
    fail("public/jupyter is missing; run jupyterlite/build.sh first")
  );
  const server = startPlaygroundServer(0);
  const browser = await chromium.launch();
  // One context: IndexedDB, where the sealed sandbox lives, is per context.
  const context = await browser.newContext();
  // The package repository, for a slim site: answered from a directory
  // when one is given (switched to the next one below).
  let repo = Deno.env.get("PLAYGROUND_SLIM_REPO");
  if (slim && repo !== undefined) {
    await context.route("https://raw.githubusercontent.com/**", async (r) => {
      const url = r.request().url();
      try {
        if (!url.startsWith(PACKAGE_REPO_URL)) throw new Error(url);
        await r.fulfill({
          body: Buffer.from(
            await Deno.readFile(
              join(repo!, url.slice(PACKAGE_REPO_URL.length)),
            ),
          ),
          headers: { "access-control-allow-origin": "*" },
        });
      } catch {
        await r.fulfill({ status: 404 });
      }
    });
  }
  const notebookUrl =
    `${server.url}/jupyter/notebooks/index.html?path=suspend-resume.ipynb`;
  const openNotebook = async (): Promise<Page> => {
    const page = await context.newPage();
    const started = Date.now();
    await page.goto(notebookUrl, { waitUntil: "domcontentloaded" });
    await page.locator(".jp-Notebook").first().waitFor({ timeout: 60_000 });
    // The plugin boots (or restores) the sandbox; the panel says when it
    // is running and the kernel has answered (idle -- or already busy
    // again, when a reopened notebook re-ran its cell in the same turn).
    await waitForPanelState(page, "running", 420_000).catch(async (error) => {
      const panel = await page.locator(".yurt-snapshot-panel").textContent()
        .catch(() => null);
      throw new Error(`the kernel did not start (panel: ${panel}): ${error}`);
    });
    await page.waitForFunction(
      () =>
        ["idle", "busy"].includes(
          document.querySelector(".jp-Notebook-ExecutionIndicator")
            ?.getAttribute("data-status") ?? "",
        ),
      undefined,
      { timeout: 120_000 },
    );
    console.log(
      `notebook snapshot e2e: kernel running after ${
        Math.round((Date.now() - started) / 1000)
      } s`,
    );
    return page;
  };
  const primesAtLeast = (page: Page, count: number, timeout: number) =>
    page.waitForFunction(
      (want) =>
        (document.querySelectorAll(".jp-CodeCell")[0]?.querySelector(
          ".jp-OutputArea",
        )?.textContent?.match(/prime #/g)?.length ?? 0) >= want,
      count,
      { timeout },
    );
  try {
    // A seal the guest's pkg does not verify is never run.
    const tampered = Deno.env.get("PLAYGROUND_SLIM_REPO_TAMPERED");
    if (slim && tampered !== undefined) {
      const other = await browser.newContext();
      await other.route("https://raw.githubusercontent.com/**", async (r) => {
        const url = r.request().url();
        try {
          if (!url.startsWith(PACKAGE_REPO_URL)) throw new Error(url);
          await r.fulfill({
            body: Buffer.from(
              await Deno.readFile(
                join(tampered, url.slice(PACKAGE_REPO_URL.length)),
              ),
            ),
            headers: { "access-control-allow-origin": "*" },
          });
        } catch {
          await r.fulfill({ status: 404 });
        }
      });
      const bad = await other.newPage();
      await bad.goto(notebookUrl, { waitUntil: "domcontentloaded" });
      await bad.waitForFunction(
        () =>
          /did not verify: pkg install Suspend\/Resume failed:[\s\S]*signature verification failed for python-seal/
            .test(document.body.innerText),
        undefined,
        { timeout: 420_000 },
      ).catch(() => fail("a seal with a bad signature was not refused"));
      const state = await bad.locator(".yurt-snapshot-panel").getAttribute(
        "data-state",
      );
      if (state === "running") {
        fail("the kernel runs a seal that did not verify");
      }
      const said = await bad.locator(".yurt-snapshot-panel").innerText();
      console.log(
        `notebook snapshot e2e: tampered seal refused: ${
          said.replace(/\s+/g, " ").slice(0, 240)
        }`,
      );
      await other.close();
    }

    let page = await openNotebook();

    // Run the primes cell.
    await page.locator(".jp-CodeCell").first().click();
    await page.keyboard.press("Shift+Enter");
    await primesAtLeast(page, 5, 120_000);

    // Close the tab once a periodic seal has landed; reopen the notebook:
    // the sandbox is restored from that seal, the plugin re-runs the cell
    // the guest never stopped running, and it continues -- numbering
    // unbroken, the primes printed before the seal shown again first.
    await page.waitForFunction(
      () =>
        document.querySelector<HTMLElement>(".yurt-snapshot-panel")?.dataset
          .sealedAt !== undefined,
      undefined,
      { timeout: 60_000 },
    );
    const atClose = await primesPrinted(page);
    await page.close();
    console.log(
      `notebook snapshot e2e: tab closed at prime #${atClose.at(-1)}`,
    );
    page = await openNotebook();
    await page.waitForFunction(
      () =>
        document.querySelector(".yurt-snapshot-state")?.textContent?.includes(
          "resumed from",
        ) === true,
      undefined,
      { timeout: 60_000 },
    );
    await primesAtLeast(page, atClose.length + 3, 120_000);
    const afterReopen = await primesPrinted(page);
    if (afterReopen.join(",") !== afterReopen.map((_, i) => i + 1).join(",")) {
      fail(`the primes are not consecutive after reopening: ${afterReopen}`);
    }
    console.log(
      `notebook snapshot e2e: reopened and reached prime #${
        afterReopen.at(-1)
      } with no button pressed`,
    );

    // Suspend: sealed and torn down; the cell's output stops growing.
    await page.locator(".yurt-snapshot-suspend").click();
    await waitForPanelState(page, "suspended", 60_000);
    const atSuspend = await primesPrinted(page);
    await page.waitForTimeout(3_000);
    const whileSuspended = await primesPrinted(page);
    if (whileSuspended.length !== atSuspend.length) {
      fail("the cell kept printing while the sandbox was suspended");
    }
    console.log(
      `notebook snapshot e2e: suspended at prime #${atSuspend.at(-1)}`,
    );

    // Resume: the same cell continues, numbering unbroken.
    await page.locator(".yurt-snapshot-resume").click();
    await waitForPanelState(page, "running", 120_000);
    await page.waitForFunction(
      (before) =>
        (document.querySelectorAll(".jp-CodeCell")[0]?.querySelector(
          ".jp-OutputArea",
        )?.textContent?.match(/prime #/g)?.length ?? 0) >= before + 3,
      atSuspend.length,
      { timeout: 120_000 },
    );
    const afterResume = await primesPrinted(page);
    const expected = afterResume.map((_, i) => i + 1);
    if (afterResume.join(",") !== expected.join(",")) {
      fail(`the primes are not consecutive after resume: ${afterResume}`);
    }
    console.log(
      `notebook snapshot e2e: resumed and reached prime #${afterResume.at(-1)}`,
    );

    // Interrupt ends the cell; the variables survived the round trip.
    await page.locator('[data-jp-item-name="interrupt"] button').click();
    await page.waitForFunction(
      () =>
        document.querySelectorAll(".jp-CodeCell")[0]?.querySelector(
          ".jp-OutputArea",
        )?.textContent?.includes("KeyboardInterrupt") === true,
      undefined,
      { timeout: 60_000 },
    );
    const total = (await primesPrinted(page)).length;
    await page.locator(".jp-CodeCell").nth(1).click();
    await page.keyboard.press("Shift+Enter");
    await page.waitForFunction(
      (count) =>
        document.querySelectorAll(".jp-CodeCell")[1]?.querySelector(
          ".jp-OutputArea",
        )?.textContent?.includes(`(${count}, [`) === true,
      total,
      { timeout: 60_000 },
    );
    console.log(
      "notebook snapshot e2e: state survived suspend, resume and interrupt",
    );

    // A newer set: a suspend made on the older one does not resume on it.
    const next = Deno.env.get("PLAYGROUND_SLIM_REPO_NEXT");
    if (slim && next !== undefined) {
      await page.locator(".jp-CodeCell").first().click();
      await page.keyboard.press("Shift+Enter");
      await primesAtLeast(page, 3, 120_000);
      await page.locator(".yurt-snapshot-suspend").click();
      await waitForPanelState(page, "suspended", 60_000);
      await page.close();
      repo = next;
      page = await openNotebook();
      const text = await page.locator("body").innerText();
      if (/resumed from/.test(text)) {
        fail("a suspend made on the older Python set was resumed");
      }
      await page.waitForFunction(
        () =>
          /was discarded: it was suspended with Python set/.test(
            document.body.innerText,
          ),
        undefined,
        { timeout: 30_000 },
      ).catch(() => fail("no word that the older suspend was discarded"));
      await page.locator(".jp-CodeCell").first().click();
      await page.keyboard.press("Shift+Enter");
      await primesAtLeast(page, 3, 120_000);
      const fresh = await primesPrinted(page);
      if (fresh[0] !== 1) fail(`the new session did not start over: ${fresh}`);
      console.log(
        "notebook snapshot e2e: the older suspend was refused; a fresh session ran on the newer set",
      );
    }
  } finally {
    await browser.close();
    await server.shutdown();
  }
}
