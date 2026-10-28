/**
 * The slim image in the browser: the page boots the image the pins name as
 * `browserImage`, the coordinator installs the newest complete Python set
 * from the repository with the guest's own `pkg`, and only then does
 * ipykernel start; a cell runs NumPy on it. A reload installs again from
 * the Cache API.
 *
 * Needs a site whose artifacts/pins.json names a slim image (it skips
 * otherwise) and the slim image in artifacts/. The repository: by default
 * the live one. PLAYGROUND_SLIM_REPO=<dir> answers the page's requests from
 * a directory in the repository's layout instead (yurt-repo-ci publish-local
 * writes one; its placeholder signatures need an image whose pkg is built
 * with test-fixtures). Then, optionally:
 *
 *   PLAYGROUND_SLIM_REPO_PARTIAL=<dir>  the same, plus part of a newer set:
 *     a reload must install the same set as before, downloading nothing
 *   PLAYGROUND_SLIM_REPO_NEXT=<dir>     the same, plus a complete newer set:
 *     a reload must install that one, with no change to the page
 *
 *   deno run -A tests/slim_e2e.ts
 */
import { type Browser, chromium, devices } from "playwright";
import { Buffer } from "node:buffer";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureBundle } from "../scripts/serve.ts";
import { startPlaygroundServer } from "../src/serve.ts";
import { PACKAGE_REPO_URL } from "../src/packages.ts";
import { watchCspViolations } from "./csp_watch.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** A phone with `?start-anyway` gets the shell, the phone note and a cell
 * that says "not on phones", and no Python install: no status about it,
 * and not one request to the repository. */
async function phoneInstallsNoPython(
  browser: Browser,
  url: string,
): Promise<void> {
  const phone = await browser.newContext(devices["iPhone 13"]);
  const fetched: string[] = [];
  phone.on("request", (request) => {
    if (request.url().startsWith(PACKAGE_REPO_URL)) {
      fetched.push(request.url());
    }
  });
  const page = await phone.newPage();
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
  await page.goto(`${url}/?start&start-anyway`, {
    waitUntil: "domcontentloaded",
  });
  // The boot is over once the page clears its boot memory: at the shell
  // on a phone. The old phone boot got there only after its Python install
  // had run or failed. ("running" alone is not enough: the status reads so
  // at "booted" too, before any install starts.)
  await page.waitForFunction(
    () =>
      document.querySelector("#status")?.textContent === "running" &&
      sessionStorage.getItem("yurt-playground-booting") === null,
    undefined,
    { timeout: 300_000 },
  );
  const state = await page.evaluate(async () => {
    const yurt = (globalThis as unknown as {
      yurt: { exec(cmd: string): Promise<{ stdout: Uint8Array | string }> };
    }).yurt;
    const out = (await yurt.exec("echo phone-shell")).stdout;
    const shown = (sel: string) => {
      const el = document.querySelector<HTMLElement>(sel);
      return el !== null && el.offsetParent !== null;
    };
    return {
      statuses: (globalThis as { __statuses?: string[] }).__statuses ?? [],
      echo: (typeof out === "string" ? out : new TextDecoder().decode(out))
        .trim(),
      phoneNote: shown("[data-testid=phone-note]"),
      cell: document.querySelector("[data-testid=notebook-status]")
        ?.textContent,
    };
  });
  const problems = [
    state.statuses.some((s) => /Python|Jupyter/.test(s)) &&
    `status mentioned Python or Jupyter: ${JSON.stringify(state.statuses)}`,
    fetched.length > 0 && `fetched from the repository: ${fetched}`,
    state.echo !== "phone-shell" && `shell answered ${state.echo}`,
    !state.phoneNote && "phone note hidden",
    state.cell !== "not on phones" && `the cell says ${state.cell}`,
  ].filter(Boolean);
  if (problems.length > 0) {
    throw new Error(`phone ?start-anyway: ${problems.join("; ")}`);
  }
  console.log("slim e2e: a phone with ?start-anyway ran the shell, no Python");
  await phone.close();
}

if (import.meta.main) {
  // A release that pins no slim image boots the full one: nothing to test.
  const pins = JSON.parse(
    await Deno.readTextFile(join(repoRoot, "artifacts/pins.json")),
  );
  if (pins.browserImage === undefined) {
    console.log("slim e2e: SKIPPED, artifacts/pins.json pins no slim image");
    Deno.exit(0);
  }
  await ensureBundle(
    Deno.env.get("YURT_KERNEL_ROOT") ?? join(repoRoot, "../yurtos-kernel"),
  );
  const repo = Deno.env.get("PLAYGROUND_SLIM_REPO");
  /** The directory the route answers from: switched between visits. */
  let current = repo;
  const server = startPlaygroundServer(0);
  const browser = await chromium.launch();
  try {
    await phoneInstallsNoPython(browser, server.url);
    const context = await browser.newContext();
    // The coordinator Worker fetches the repository; a context route sees
    // a dedicated worker's requests, a page route does not.
    // Every repository request the browser makes, the coordinator Worker's
    // included, whether the route below answers it or the live repository.
    const fetched: string[] = [];
    context.on("request", (request) => {
      if (request.url().startsWith(PACKAGE_REPO_URL)) {
        fetched.push(request.url());
      }
    });
    if (repo !== undefined) {
      await context.route("https://raw.githubusercontent.com/**", async (r) => {
        const url = r.request().url();
        try {
          if (!url.startsWith(PACKAGE_REPO_URL)) throw new Error(url);
          await r.fulfill({
            body: Buffer.from(
              await Deno.readFile(
                join(current!, url.slice(PACKAGE_REPO_URL.length)),
              ),
            ),
            headers: { "access-control-allow-origin": "*" },
          });
        } catch {
          await r.fulfill({ status: 404 });
        }
      });
    }
    const page = await context.newPage();
    // Every status the page shows, as it shows it: some last only a second
    // (the layer's write, its gzip), shorter than the poll below.
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
    const shownStatuses = () =>
      page.evaluate(() =>
        (globalThis as { __statuses?: string[] }).__statuses ?? []
      );
    const csp = watchCspViolations(page);
    if (Deno.env.get("SLIM_E2E_CONSOLE") === "1") {
      page.on("console", (m) => console.log(`[console] ${m.text()}`));
    }
    /** Load the page and wait for the cell to settle; the statuses it
     * showed, in order. */
    const bootToReady = async (
      label: string,
      from: "pkg" | "layer" = "pkg",
    ): Promise<string[]> => {
      const statuses: string[] = [];
      const started = Date.now();
      await page.goto(`${server.url}/?start`, {
        waitUntil: "domcontentloaded",
      });
      const settled = [
        "ready",
        "installing Python failed",
        "Jupyter did not start",
      ];
      for (;;) {
        const text = await page.locator("[data-testid=notebook-status]")
          .textContent({ timeout: 60_000 }).catch(() => null) ?? "";
        if (statuses.at(-1) !== text) {
          statuses.push(text);
          console.log(
            `slim e2e (${label}): ${
              Math.round((Date.now() - started) / 1000)
            } s ${text}`,
          );
        }
        if (settled.includes(text)) break;
        if (Date.now() - started > 900_000) {
          throw new Error(`no settled state in 900 s: ${text}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      if (statuses.at(-1) !== "ready") {
        const reason = await page.getByTestId("python-install-reason")
          .textContent();
        const status = await page.locator("#status").textContent();
        throw new Error(
          `${label}: the cell is "${
            statuses.at(-1)
          }": ${reason} (status: ${status})`,
        );
      }
      const all = [...statuses, ...await shownStatuses()];
      const ranPkg = all.some((s) =>
        /^Python: verifying and installing/.test(s)
      );
      const fromLayer = all.includes(
        "Python: installing from this browser's earlier install",
      );
      if (from === "pkg" && (!ranPkg || fromLayer)) {
        throw new Error(
          `${label}: no pkg install was shown: ${JSON.stringify(statuses)}`,
        );
      }
      // Instant Python: the earlier install's layer, and no guest pkg run.
      if (from === "layer" && (!fromLayer || ranPkg)) {
        throw new Error(
          `${label}: the stored install was not used: ${
            JSON.stringify(statuses)
          }`,
        );
      }
      console.log(
        `slim e2e (${label}): Jupyter ready ${
          Math.round((Date.now() - started) / 1000)
        } s after load, Python installed first (${from})`,
      );
      return all;
    };
    /** The `pkg install …` line a visit showed. */
    const installed = (statuses: string[]) =>
      statuses.find((s) => /^Python: verifying and installing/.test(s))
        ?.replace(/^.*\((pkg install [^)]*)\).*$/, "$1") ?? "";
    const numpyCell = async () => {
      await page.getByTestId("notebook-input").fill(
        "import numpy; print(int((numpy.arange(4) ** 2).sum()), numpy.__version__)",
      );
      await page.getByTestId("notebook-execute").click();
      await page.waitForFunction(
        () =>
          /\d/.test(
            document.querySelector("[data-testid=notebook-output]")
              ?.textContent ?? "",
          ),
        undefined,
        { timeout: 120_000 },
      );
      const output = (await page.getByTestId("notebook-output").textContent())
        ?.trim();
      if (!output?.startsWith("14 ")) {
        throw new Error(`the NumPy cell printed ${JSON.stringify(output)}`);
      }
      console.log(`slim e2e: cell printed ${JSON.stringify(output)}`);
    };
    const archivesSince = (n: number) =>
      fetched.slice(n).filter((u) =>
        u.endsWith(".yurtpkg") || u.endsWith(".yurtpkg.bundle")
      );
    // A desktop browser installs Python on its own (bootToReady requires
    // the install's status), unlike the phone above.
    const firstStatuses = await bootToReady("first visit");
    const first = installed(firstStatuses);
    console.log(`slim e2e: installed ${first}`);
    if (
      !firstStatuses.includes("Python: keeping the install for the next visit")
    ) {
      throw new Error("the first install was not kept for the next visit");
    }
    await numpyCell();
    if (archivesSince(0).length === 0) {
      throw new Error("no archive was fetched from the repository");
    }
    // A reload loses the sandbox's files (#81). The live index still names
    // the same set, so the install the first visit kept is written in, and
    // pkg does not run: no archive is fetched, only the index read.
    let before = fetched.length;
    await bootToReady("reload", "layer");
    if (archivesSince(before).length > 0) {
      throw new Error(`the reload downloaded again: ${archivesSince(before)}`);
    }
    if (fetched.length === before) {
      throw new Error("the reload did not read the repository's index");
    }
    await numpyCell();
    // The repository unreachable (offline): the stored install still.
    await context.route(`${PACKAGE_REPO_URL}**`, (route) => route.abort());
    await bootToReady("repository unreachable", "layer");
    await numpyCell();
    await context.unroute(`${PACKAGE_REPO_URL}**`);
    // Part of a newer set is published: still the complete one.
    const partial = Deno.env.get("PLAYGROUND_SLIM_REPO_PARTIAL");
    if (partial !== undefined) {
      current = partial;
      before = fetched.length;
      // Still the stored install's set: the layer.
      await bootToReady("partial newer set", "layer");
      if (archivesSince(before).length > 0) {
        throw new Error(
          `with a partial newer set the page downloaded ${
            archivesSince(before)
          }`,
        );
      }
      console.log("slim e2e: a partly published set was not chosen");
    }
    // A complete newer set: the page installs it, with no change to it.
    const next = Deno.env.get("PLAYGROUND_SLIM_REPO_NEXT");
    if (next !== undefined) {
      current = next;
      before = fetched.length;
      const newer = installed(await bootToReady("newer set"));
      if (newer === first || archivesSince(before).length === 0) {
        throw new Error(`the newer set was not installed: ${newer}`);
      }
      console.log(`slim e2e: installed the newer set: ${newer}`);
      await numpyCell();
    }
    csp();
    console.log("slim e2e: passed");
  } finally {
    await browser.close();
    await server.shutdown();
  }
}
