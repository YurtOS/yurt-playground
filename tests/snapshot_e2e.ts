/**
 * The continuous-snapshot demo, end to end in headless Chromium: a run
 * boots fresh and seals; the tab is closed; a new tab restores and the
 * guest's first line is the prime right after where the last seal had it —
 * no restart from #1, no gap, no repeat beyond what the seal interval
 * allows. Run: `deno run --allow-all tests/snapshot_e2e.ts` (needs the
 * kernel checkout and pinned artifacts like playground_e2e.ts).
 */
import { chromium, type Page } from "playwright";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureBundle } from "../scripts/serve.ts";
import { startPlaygroundServer } from "../src/serve.ts";
import { RESTORE_MARKER } from "../src/snapshot_store.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function primeIndices(text: string): number[] {
  return [...text.matchAll(/prime #(\d+) = \d+/g)].map((m) => Number(m[1]));
}

function driver(page: Page) {
  return {
    output: () =>
      page.evaluate(() => globalThis.yurtSnapshotDemo?.output() ?? ""),
    began: () =>
      page.evaluate(() => globalThis.yurtSnapshotDemo?.began() ?? "booting"),
    seals: () => page.evaluate(() => globalThis.yurtSnapshotDemo?.seals() ?? 0),
    async until(
      what: string,
      ready: () => Promise<boolean>,
      timeoutMs = 60_000,
    ) {
      const deadline = Date.now() + timeoutMs;
      while (!(await ready())) {
        if (Date.now() > deadline) {
          const status = await page.locator("#status").textContent();
          const tail = (await page.evaluate(() =>
            globalThis.yurtSnapshotDemo?.output() ?? ""
          )).slice(-300);
          throw new Error(
            `timed out waiting for ${what}; status: ${status}; output tail: ${
              JSON.stringify(tail)
            }`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    },
  };
}

if (import.meta.main) {
  await ensureBundle(
    Deno.env.get("YURT_KERNEL_ROOT") ?? join(repoRoot, "../yurtos-kernel"),
  );
  const server = startPlaygroundServer(0);
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    const url = `${server.url}/snapshot.html`;

    // First run: fresh, forget any image an earlier run left behind.
    let page = await context.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded" });
    let d = driver(page);
    await d.until("the first run to start", async () => {
      const began = await d.began();
      return began === "booted" || began === "restored";
    });
    if (await d.began() === "restored") {
      await page.locator("#reset").click();
      await d.until(
        "the reset",
        async () =>
          (await page.locator("#status").textContent() ?? "").includes(
            "dropped",
          ),
      );
      await page.reload({ waitUntil: "domcontentloaded" });
      d = driver(page);
      await d.until("a fresh boot", async () => await d.began() === "booted");
    }
    await d.until("two seals", async () => await d.seals() >= 2);
    await d.until(
      "twenty primes",
      async () => primeIndices(await d.output()).length >= 20,
    );
    const sealsBefore = await d.seals();
    await d.until("one more seal", async () => await d.seals() > sealsBefore);
    const before = primeIndices(await d.output());
    const lastBefore = before.at(-1)!;
    await page.close();

    // Second run: a new tab restores the image the first one stored.
    page = await context.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded" });
    d = driver(page);
    await d.until("the restore", async () => await d.began() === "restored");
    await d.until(
      "ten restored primes",
      async () => primeIndices(await d.output()).length >= 10,
    );
    const output = await d.output();
    if (!output.includes(RESTORE_MARKER)) {
      throw new Error("restored run printed no restore marker");
    }
    const after = primeIndices(output.slice(output.indexOf(RESTORE_MARKER)));
    const first = after[0];
    // The image is at most one seal interval (2 s, ~8 primes at 4/s) behind
    // what the first tab showed, and never ahead of it by more than the one
    // write a seal can catch pending.
    if (first < lastBefore - 16 || first > lastBefore + 1) {
      throw new Error(
        `restored run resumed at prime #${first}; the first run had reached #${lastBefore}`,
      );
    }
    for (let i = 1; i < after.length; i++) {
      if (after[i] !== after[i - 1] + 1) {
        throw new Error(
          `restored primes are not consecutive: #${after[i - 1]} then #${
            after[i]
          }`,
        );
      }
    }
    console.log(
      `snapshot demo: first run reached #${lastBefore}, restored run resumed at #${first} and continued`,
    );
    await page.close();
    await context.close();
  } finally {
    await browser.close();
    await server.shutdown();
  }
}
