/**
 * Save sandbox and Load sandbox (yurt-playground#8), end to end: a file
 * made in the shell is saved with the sandbox, deleted, and back after
 * the downloaded zip is loaded -- in a new shell on the terminal and in a
 * Jupyter cell; a cell still running when Save seals ends at once. A
 * stale, a damaged and an oversized file are each refused
 * with the running shell untouched (a shell variable set before is still
 * set after). Prints Save's and Load's times.
 *
 * Run: `deno run --allow-all tests/sandbox_file_e2e.ts` (the runner's Chrome) or with
 * `E2E_ENGINE=webkit`; needs the kernel checkout, the pinned artifacts and
 * the desktop snapshot in public/snapshot/ (YURT_INSTALL_SNAPSHOT=1
 * scripts/install-pinned-artifacts.sh), like playground_e2e.ts.
 */
import { type Page, webkit } from "playwright";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launchBrowser } from "../scripts/browser.ts";
import { ensureBundle } from "../scripts/serve.ts";
import { startPlaygroundServer } from "../src/serve.ts";
import { writeZip, ZipStreamReader } from "../src/snapshot_zip.ts";
import { type SandboxFileMessage, sandboxFileOk } from "../src/sandbox_file.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const BOOT_MS = 300_000;

type Done = Extract<SandboxFileMessage, { type: "sandbox-done" }>;

/** Type `line` into the terminal; the screen once `marker` is printed. */
async function shell(page: Page, line: string): Promise<string> {
  const marker = `__E2E_${crypto.randomUUID().slice(0, 8)}__`;
  await page.locator("#term").click();
  await page.keyboard.type(`clear; ${line}; echo ${marker}\n`);
  await page.waitForFunction(
    (marker) =>
      [...document.querySelectorAll("#term .xterm-rows > div")]
        .some((row) => row.textContent?.trim() === marker),
    marker,
    { timeout: 60_000 },
  );
  return await page.locator("#term .xterm-rows").innerText();
}

async function notebookReady(page: Page, what: string): Promise<void> {
  await page.waitForFunction(
    () =>
      document.querySelector("[data-testid=notebook-status]")?.textContent ===
        "ready" ||
      (document.querySelector("#status")?.textContent ?? "").includes(
        "failed",
      ),
    undefined,
    { timeout: BOOT_MS },
  );
  const notebook = await page.getByTestId("notebook-status").textContent();
  if (notebook !== "ready") {
    throw new Error(
      `${what}: Jupyter not ready (${notebook}); status: ${await page.locator(
        "#status",
      ).textContent()}`,
    );
  }
}

/** Start a save or load with `act`, and its `sandbox-done`. */
async function sandboxFile(
  page: Page,
  act: () => Promise<void>,
): Promise<Done> {
  await page.evaluate(() =>
    delete document.documentElement.dataset.sandboxFileDone
  );
  await act();
  await page.waitForFunction(
    () => document.documentElement.dataset.sandboxFileDone !== undefined,
    undefined,
    { timeout: BOOT_MS },
  );
  return JSON.parse(
    await page.evaluate(() =>
      document.documentElement.dataset.sandboxFileDone!
    ),
  );
}

/** The manifest of a snapshot zip at `path`, parsed. */
async function manifestOf(path: string): Promise<Record<string, unknown>> {
  const file = await Deno.open(path);
  const reader = file.readable.getReader();
  try {
    const zip = new ZipStreamReader(reader);
    const entry = await zip.next();
    return JSON.parse(
      new TextDecoder().decode(await zip.readWhole(entry!, 1 << 20)),
    );
  } finally {
    await reader.cancel().catch(() => {});
  }
}

/** A snapshot zip of `manifest` and 64 KiB of memory, at a new path. */
async function craft(
  dir: string,
  name: string,
  manifest: Record<string, unknown>,
): Promise<string> {
  const path = join(dir, name);
  const blob = await writeZip([
    {
      name: "snapshot.json",
      bytes: new TextEncoder().encode(JSON.stringify(manifest)),
      deflate: false,
    },
    { name: "kernel-memory", bytes: new Uint8Array(65536), deflate: true },
  ]);
  await Deno.writeFile(path, new Uint8Array(await blob.arrayBuffer()));
  return path;
}

if (import.meta.main) {
  await ensureBundle(
    Deno.env.get("YURT_KERNEL_ROOT") ?? join(repoRoot, "../yurtos-kernel"),
  );
  const engine = Deno.env.get("E2E_ENGINE") ?? "chrome";
  const server = startPlaygroundServer(0);
  const browser = engine === "webkit"
    ? await webkit.launch()
    : await launchBrowser();
  const dir = await Deno.makeTempDir({ prefix: "sandbox-file-e2e-" });
  try {
    const page = await (await browser.newContext({ acceptDownloads: true }))
      .newPage();
    page.on("pageerror", (error) => console.error("pageerror:", error));
    page.on("console", (message) => {
      if (/^\[(sandbox|snapshot)\]/.test(message.text())) {
        console.log(`  ${message.text()}`);
      }
    });
    const started = Date.now();
    await page.goto(`${server.url}/?start`, { waitUntil: "domcontentloaded" });
    await notebookReady(page, "boot");
    console.log(`${engine}: Jupyter ready after ${Date.now() - started} ms`);

    // A file in the shell, and a variable only this shell has.
    await shell(page, "echo kept-8 > ~/kept.txt; X=old-shell");

    // A cell that would run for minutes: Save stops its kernel, and the
    // cell must end then, not at its own timeout.
    await page.getByTestId("notebook-input").fill(
      "import time; time.sleep(600)",
    );
    await page.getByTestId("notebook-execute").click();

    // Save: the download, and the session back with the file.
    const downloaded = page.waitForEvent("download", { timeout: BOOT_MS });
    const saveStarted = Date.now();
    const cellEnded = page.waitForFunction(
      () =>
        /the sandbox was replaced/.test(
          document.querySelector("[data-testid=notebook-output]")
            ?.textContent ?? "",
        ),
      undefined,
      { timeout: 60_000 },
    );
    const saved = await sandboxFile(
      page,
      () => page.getByTestId("save-sandbox").click(),
    );
    if (!sandboxFileOk(saved)) {
      throw new Error(`save failed: ${JSON.stringify(saved)}`);
    }
    await cellEnded;
    const download = await downloaded;
    const zip = join(dir, download.suggestedFilename());
    await download.saveAs(zip);
    await notebookReady(page, "after save");
    const saveMs = Date.now() - saveStarted;
    const size = (await Deno.stat(zip)).size;
    console.log(
      `${engine}: save ${saved.ms} ms in the worker, ${saveMs} ms to Jupyter ready again; ` +
        `${download.suggestedFilename()} ${size} bytes`,
    );
    if (!(await shell(page, "cat ~/kept.txt")).includes("kept-8")) {
      throw new Error("the file is gone after Save");
    }

    // Delete it, and mark the shell that refusals must leave alone.
    await shell(page, "rm ~/kept.txt; Y=untouched");

    // Refused, each before anything changes.
    const manifest = await manifestOf(zip);
    const built = manifest.builtFrom as Record<string, unknown>;
    const damaged = new Uint8Array(await Deno.readFile(zip));
    // A byte of the stored manifest: inflate cannot notice, the CRC-32
    // must (30-byte header, then the name).
    damaged[30 + "snapshot.json".length + 2] ^= 0x01;
    await Deno.writeFile(join(dir, "damaged.zip"), damaged);
    const refusals: [string, RegExp][] = [
      [
        await craft(dir, "stale.zip", {
          ...manifest,
          builtFrom: { ...built, kernelSha256: "00".repeat(32) },
        }),
        /saved by another Yurt build \(kernelSha256/,
      ],
      [join(dir, "damaged.zip"), /snapshot\.json fails its CRC-32/],
      [
        await craft(dir, "huge.zip", { ...manifest, memoryBytes: 2 ** 31 }),
        /over the 1024 MiB this page loads/,
      ],
    ];
    for (const [path, expect] of refusals) {
      const done = await sandboxFile(
        page,
        () => page.getByTestId("load-input").setInputFiles(path),
      );
      if (done.outcome !== "refused" || !expect.test(done.why ?? "")) {
        throw new Error(
          `${path}: not refused as ${expect}: ${JSON.stringify(done)}`,
        );
      }
      const screen = await shell(page, 'echo "[$Y]"; ls ~/kept.txt');
      if (!screen.includes("[untouched]") || !/No such file/.test(screen)) {
        throw new Error(`${path}: the session changed:\n${screen}`);
      }
      console.log(`${engine}: refused ${path.split("/").at(-1)}: ${done.why}`);
    }
    const status = await page.locator("#status").textContent();
    if (!status?.includes("nothing changed")) {
      throw new Error(`a refusal is not said in the status line: ${status}`);
    }

    // Load: the file is back, in a new shell and in the cell.
    const loadStarted = Date.now();
    const loaded = await sandboxFile(
      page,
      () => page.getByTestId("load-input").setInputFiles(zip),
    );
    if (!sandboxFileOk(loaded)) {
      throw new Error(`load failed: ${JSON.stringify(loaded)}`);
    }
    await notebookReady(page, "after load");
    const loadMs = Date.now() - loadStarted;
    console.log(
      `${engine}: load ${loaded.ms} ms in the worker, ${loadMs} ms to Jupyter ready again`,
    );
    const screen = await shell(page, 'cat ~/kept.txt; echo "[$X][$Y]"');
    if (!screen.includes("kept-8")) {
      throw new Error(`the file is not back after Load:\n${screen}`);
    }
    // A new shell on the terminal: neither variable survives.
    if (!screen.includes("[][]")) {
      throw new Error(`Load did not start a new shell:\n${screen}`);
    }
    await page.getByTestId("notebook-input").fill(
      "print(open('/home/user/kept.txt').read().strip())",
    );
    await page.getByTestId("notebook-execute").click();
    await page.waitForFunction(
      () => {
        const text = document.querySelector("[data-testid=notebook-output]")
          ?.textContent ?? "";
        if (/Error|Traceback/.test(text)) throw new Error(text);
        return text.includes("kept-8");
      },
      undefined,
      { timeout: 120_000 },
    );
    console.log(
      `${engine}: PASS (save ${saveMs} ms, load ${loadMs} ms, total ${
        Date.now() - started
      } ms)`,
    );
  } finally {
    await browser.close();
    await server.shutdown();
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}
