/**
 * The slim image in the browser: the page boots the image the pins name as
 * `browserImage`, the coordinator installs the pinned Python packages with
 * the guest's own `pkg`, and only then does ipykernel start; a cell runs
 * NumPy on it.
 *
 * Needs a site whose artifacts/pins.json names a slim image and the Python
 * packages (it skips otherwise), the slim image in artifacts/, and the
 * repository the packages come from. PLAYGROUND_SLIM_REPO=<dir> answers the page's repository
 * requests from a directory in the repository's layout (yurt-repo-ci
 * publish-local writes one; its placeholder signatures need an image whose
 * pkg is built with test-fixtures); unset, they go to the live repository.
 *
 *   deno run -A tests/slim_e2e.ts
 */
import { chromium } from "playwright";
import { Buffer } from "node:buffer";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureBundle } from "../scripts/serve.ts";
import { startPlaygroundServer } from "../src/serve.ts";
import { PACKAGE_REPO_URL } from "../src/packages.ts";
import { watchCspViolations } from "./csp_watch.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

if (import.meta.main) {
  // A release that pins no slim image boots the full one: nothing to test.
  const pins = JSON.parse(
    await Deno.readTextFile(join(repoRoot, "artifacts/pins.json")),
  );
  if (pins.browserImage === undefined || pins.pythonPackages === undefined) {
    console.log(
      "slim e2e: SKIPPED, artifacts/pins.json pins no slim image and Python packages",
    );
    Deno.exit(0);
  }
  await ensureBundle(
    Deno.env.get("YURT_KERNEL_ROOT") ?? join(repoRoot, "../yurtos-kernel"),
  );
  const repo = Deno.env.get("PLAYGROUND_SLIM_REPO");
  const server = startPlaygroundServer(0);
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    // The coordinator Worker fetches the repository; a context route sees
    // a dedicated worker's requests, a page route does not.
    const fetched: string[] = [];
    if (repo !== undefined) {
      await context.route("https://raw.githubusercontent.com/**", async (r) => {
        const url = r.request().url();
        fetched.push(url);
        try {
          if (!url.startsWith(PACKAGE_REPO_URL)) throw new Error(url);
          await r.fulfill({
            body: Buffer.from(
              await Deno.readFile(
                join(repo, url.slice(PACKAGE_REPO_URL.length)),
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
    const csp = watchCspViolations(page);
    if (Deno.env.get("SLIM_E2E_CONSOLE") === "1") {
      page.on("console", (m) => console.log(`[console] ${m.text()}`));
    }
    /** Load the page and wait for the cell to settle; the statuses it
     * showed, in order. */
    const bootToReady = async (label: string): Promise<string[]> => {
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
      if (!statuses.some((s) => /^Python: verifying and installing/.test(s))) {
        throw new Error(
          `${label}: no Python install was shown: ${JSON.stringify(statuses)}`,
        );
      }
      console.log(
        `slim e2e (${label}): Jupyter ready ${
          Math.round((Date.now() - started) / 1000)
        } s after load, Python installed first`,
      );
      return statuses;
    };
    await bootToReady("first visit");
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
    if (repo !== undefined && !fetched.some((u) => u.endsWith(".yurtpkg"))) {
      throw new Error("no archive was fetched from the repository");
    }
    // A reload loses the sandbox's files (#81) and installs again, from the
    // archives the Cache API kept: only the index and metadata are fetched.
    const before = fetched.length;
    await bootToReady("reload");
    const refetched = fetched.slice(before).filter((u) =>
      u.endsWith(".yurtpkg") || u.endsWith(".yurtpkg.bundle")
    );
    if (refetched.length > 0) {
      throw new Error(`the reload downloaded again: ${refetched.join(", ")}`);
    }
    if (repo !== undefined && fetched.length === before) {
      throw new Error("the reload did not read the repository's index");
    }
    csp();
    console.log("slim e2e: passed");
  } finally {
    await browser.close();
    await server.shutdown();
  }
}
