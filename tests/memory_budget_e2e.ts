/**
 * An iPad's first Python, under the memory iOS gives a tab, end to end in
 * Chrome. On iPhones and iPads the first `python3` failed or the tab was
 * killed: the kernel's JS host copied the guest binary several times in the
 * coordinator on every exec (yurtos-kernel#4238), and every shared
 * `WebAssembly.Memory` in the tab draws on one cap of about 4 GiB.
 *
 * The tab is an emulated iPad (`?start`, as a tablet starts, restoring the
 * tablet snapshot). Before anything loads, tests/alloc_census.ts counts the
 * large buffers every realm makes (page, coordinator, guests, the
 * reservation probe) and the shared-memory reservations still live, and
 * refuses a reservation past 4 GiB as iOS does. So the page takes the iOS
 * path: its reservation probe stops short and it plans 128 MiB per process.
 *
 * It runs the first `python3 -c 'print(6*7)'`, a second one, a shell
 * command and the Python REPL in the terminal, then checks the budgets:
 *
 * - the coordinator's buffers of 1 MiB or more during the first python3
 *   exec stay under {@link FIRST_EXEC_COORDINATOR_BUDGET_BYTES};
 * - no shared-memory reservation was refused at the simulated cap: the
 *   census admits one only while the live total stays under it, so a
 *   refusal is how reaching the cap shows (the peak is logged).
 *
 * Run: `deno run --allow-all tests/memory_budget_e2e.ts` (needs the kernel
 * checkout, the pinned artifacts and the pinned tablet snapshot in
 * public/snapshot/: `YURT_INSTALL_SNAPSHOT=tabletSnapshot
 * scripts/install-pinned-artifacts.sh`).
 */
import { devices, type Page } from "playwright";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launchBrowser } from "../scripts/browser.ts";
import { ensureBundle } from "../scripts/serve.ts";
import { handlePlaygroundRequest } from "../src/serve.ts";
import {
  allocationCensus,
  type CensusConfig,
  type CensusReading,
  censusSource,
} from "./alloc_census.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIB = 1024 * 1024;

/** The per-tab cap iOS WebKit puts on shared memory reservations
 *  (src/guest_memory_reservation.ts: about 4-4.5 GiB on an iPad). */
const SIMULATED_CAP_BYTES = 4096 * MIB;

/**
 * The coordinator's allocations of 1 MiB or more while it runs the first
 * `python3 -c 'print(6*7)'` after the tablet snapshot's restore.
 *
 * Measured in headless Chrome 157 on macOS, pinned kernel wasm and tablet
 * snapshot (train 2026.11.17-cb7a4b7), the same on every run:
 *
 * | kernel JS host                          | first | second |
 * | --------------------------------------- | ----- | ------ |
 * | cb7a4b7 (the pin before #4238's fix)    | 650   | 291    |
 * | cb7a4b7 + yurtos-kernel#5039            | 245   | 212    |
 * | cb7a4b7 + yurtos-kernel#5039 and #5043  | 96    | 63     |
 *
 * (MiB of buffers of 1 MiB or more in the coordinator, first and second
 * python3.) The budget sits between the host without #5039 and the one
 * with it, so losing #5039's single-copy exec turns this scene red.
 */
const FIRST_EXEC_COORDINATOR_BUDGET_BYTES = 384 * MIB;

const CENSUS: CensusConfig = {
  capBytes: SIMULATED_CAP_BYTES,
  bigBytes: MIB,
};

/** The Worker scripts the census is put in front of. */
const WORKER_SCRIPTS =
  /^\/(coordinator\.bundle|worker_bootstrap|memory-probe)\.js$/;

/**
 * The playground's own server, with `prelude` in front of each Worker
 * script. Here, not in a Playwright route: a route does not see the
 * requests of a Worker's own Workers (the coordinator starts the probe).
 */
function serveWithCensus(prelude: string) {
  const server = Deno.serve(
    { port: 0, hostname: "127.0.0.1", onListen: () => {} },
    async (request) => {
      const response = await handlePlaygroundRequest(request);
      if (
        !response.ok || !WORKER_SCRIPTS.test(new URL(request.url).pathname)
      ) {
        return response;
      }
      const headers = new Headers(response.headers);
      headers.delete("content-length");
      return new Response(prelude + await response.text(), {
        status: response.status,
        headers,
      });
    },
  );
  return {
    url: `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`,
    shutdown: () => server.shutdown(),
  };
}

type Result = { code: number; stdout: string; stderr: string };

function census(page: Page): Promise<CensusReading> {
  return page.evaluate(() =>
    (globalThis as unknown as {
      __yurtCensus: { read(): CensusReading };
    }).__yurtCensus.read()
  );
}

function exec(page: Page, cmd: string): Promise<Result> {
  return page.evaluate(async (cmd) => {
    const yurt = (globalThis as unknown as {
      yurt: {
        exec(cmd: string): Promise<{
          code: number;
          stdout: Uint8Array | string;
          stderr: Uint8Array | string;
        }>;
      };
    }).yurt;
    const text = (b: Uint8Array | string) =>
      typeof b === "string" ? b : new TextDecoder().decode(b);
    let result;
    try {
      result = await Promise.race([
        yurt.exec(cmd),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("no answer in 120 s")), 120_000)
        ),
      ]);
    } catch (error) {
      return { code: -1, stdout: "", stderr: String(error) };
    }
    return {
      code: result.code,
      stdout: text(result.stdout),
      stderr: text(result.stderr),
    };
  }, cmd);
}

function mib(bytes: number): string {
  return `${Math.round(bytes / MIB)} MiB`;
}

function summary(label: string, reading: CensusReading): string {
  const kinds = Object.entries(reading.kinds)
    .filter(([, t]) => t.realms > 0)
    .map(([kind, t]) =>
      `${kind}×${t.realms}: ${t.bigCount} big = ${mib(t.bigBytes)} ` +
      `(max ${mib(t.bigMaxBytes)}), ${t.memories} memories, ` +
      `${mib(t.liveReservedBytes)} reserved`
    );
  return `[census] ${label}: live ${mib(reading.liveReservedBytes)}, ` +
    `peak ${mib(reading.peakReservedBytes)}, refused ${reading.refused}; ` +
    kinds.join("; ");
}

/** Coordinator buffers of 1 MiB or more made between two readings. */
function coordinatorDelta(before: CensusReading, after: CensusReading) {
  const b = before.kinds.coordinator, a = after.kinds.coordinator;
  return { count: a.bigCount - b.bigCount, bytes: a.bigBytes - b.bigBytes };
}

/** The terminal's text, one trimmed line per row. */
function terminalLines(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(
      document.querySelectorAll("#term .xterm-rows > div"),
      (row) => (row.textContent ?? "").replace(/ /g, " ").trim(),
    )
  );
}

async function waitForLine(
  page: Page,
  what: string,
  ok: (line: string) => boolean,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const lines = await terminalLines(page);
    if (lines.some(ok)) return;
    if (Date.now() > deadline) {
      throw new Error(
        `timed out waiting for ${what}; terminal: ${
          lines.filter(Boolean).slice(-8).join(" | ")
        }`,
      );
    }
    await page.waitForTimeout(200);
  }
}

if (import.meta.main) {
  await ensureBundle(
    Deno.env.get("YURT_KERNEL_ROOT") ?? join(repoRoot, "../yurtos-kernel"),
  );
  try {
    await Deno.stat(join(repoRoot, "public/snapshot/tablet.seal.zip"));
  } catch {
    throw new Error(
      "public/snapshot/tablet.seal.zip is missing: " +
        "YURT_INSTALL_SNAPSHOT=tabletSnapshot scripts/install-pinned-artifacts.sh",
    );
  }
  const server = serveWithCensus(censusSource(CENSUS));
  // `gc()` in every realm: the census collects before it refuses, as
  // JavaScriptCore does.
  const browser = await launchBrowser({ args: ["--js-flags=--expose-gc"] });
  try {
    const context = await browser.newContext(devices["iPad Pro 11"]);
    await context.addInitScript(allocationCensus, CENSUS);
    const page = await context.newPage();
    const logs: string[] = [];
    page.on("console", (message) => {
      const text = message.text();
      logs.push(text);
      if (
        /^\[(memory|snapshot|census)\]/.test(text) ||
        message.type() === "error" || message.type() === "warning"
      ) {
        console.log(`[${message.type()}] ${text}`);
      }
    });
    page.on("pageerror", (error) => console.log(`[pageerror] ${error}`));

    await page.goto(`${server.url}/?start`, {
      waitUntil: "domcontentloaded",
    });
    await page.waitForFunction(
      () => document.querySelector("#status")?.textContent === "running",
      undefined,
      { timeout: 240_000 },
    );
    const problems: string[] = [];
    if (!logs.some((l) => /^\[snapshot\] \d+ bytes of kernel memory/.test(l))) {
      problems.push("the tablet snapshot was not restored");
    }
    if (!logs.some((l) => l.startsWith("[memory] 128 MiB per process"))) {
      problems.push(
        `the page did not plan iOS's 128 MiB per process: ${
          JSON.stringify(logs.filter((l) => l.startsWith("[memory]")))
        }`,
      );
    }
    const booted = await census(page);
    console.log(summary("booted", booted));

    const firstPython = await exec(page, "python3 -c 'print(6*7)'");
    const afterFirst = await census(page);
    const first = coordinatorDelta(booted, afterFirst);
    console.log(summary("first python3", afterFirst));
    console.log(
      `[census] coordinator during the first python3: ${first.count} ` +
        `buffers of 1 MiB or more, ${mib(first.bytes)}`,
    );
    if (firstPython.code !== 0 || firstPython.stdout.trim() !== "42") {
      problems.push(`first python3: ${JSON.stringify(firstPython)}`);
    }

    const secondPython = await exec(page, "python3 -c 'print(6*7)'");
    const afterSecond = await census(page);
    const second = coordinatorDelta(afterFirst, afterSecond);
    console.log(
      `[census] coordinator during the second python3: ${second.count} ` +
        `buffers of 1 MiB or more, ${mib(second.bytes)}`,
    );
    if (secondPython.code !== 0 || secondPython.stdout.trim() !== "42") {
      problems.push(`second python3: ${JSON.stringify(secondPython)}`);
    }

    const shell = await exec(page, "echo shell-$((6*7)) && ls / >/dev/null");
    if (shell.code !== 0 || shell.stdout.trim() !== "shell-42") {
      problems.push(`shell: ${JSON.stringify(shell)}`);
    }

    // A failed command above leaves no REPL to wait for.
    if (problems.length > 0) {
      const now = await census(page);
      throw new Error(
        `memory budget: ${problems.join("; ")} ` +
          `(${now.refused} reservations refused at the simulated cap)`,
      );
    }
    // The REPL, typed into the terminal as a person would.
    await page.locator("#term").click();
    await page.keyboard.type("python3\n");
    await waitForLine(page, "the REPL prompt", (l) => l === ">>>", 120_000);
    await page.keyboard.type("[x*x for x in range(5)]\n");
    await waitForLine(
      page,
      "the REPL's answer",
      (l) => l === "[0, 1, 4, 9, 16]",
      60_000,
    );
    await page.keyboard.type("exit()\n");
    const end = await census(page);
    console.log(summary("after the REPL", end));

    if (first.bytes >= FIRST_EXEC_COORDINATOR_BUDGET_BYTES) {
      problems.push(
        `the coordinator made ${mib(first.bytes)} of buffers of 1 MiB or ` +
          `more during the first python3, budget ` +
          mib(FIRST_EXEC_COORDINATOR_BUDGET_BYTES),
      );
    }
    if (end.refused !== 0) {
      problems.push(
        `${end.refused} reservations refused at the simulated cap: ${
          JSON.stringify(logs.filter((l) => l.includes("simulated iOS cap")))
        }`,
      );
    }
    if (problems.length > 0) {
      throw new Error(`memory budget: ${problems.join("; ")}`);
    }
    console.log(
      `memory budget: first python3 ${mib(first.bytes)} in the ` +
        `coordinator (budget ${mib(FIRST_EXEC_COORDINATOR_BUDGET_BYTES)}), ` +
        `peak reserved ${mib(end.peakReservedBytes)} of ` +
        mib(SIMULATED_CAP_BYTES),
    );
    await context.close();
  } finally {
    await browser.close();
    await server.shutdown();
  }
}
