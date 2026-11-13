/**
 * yurtos-x86 in the browser (a local scene, not a CI acceptance job): the
 * terminal installs the published `yurtos-x86` package with its own
 * `sudo pkg` -- typed, as a person would, through the page's package relay
 * (src/pkg_relay.ts) -- then runs x86-64 programs from the terminal and
 * through `window.yurt.exec`, whose timings it prints.
 *
 * It needs the network and the live YurtOS/yurt-packages repository, so it
 * runs by hand: `deno run --allow-all tests/x86_local.ts` (with the kernel
 * checkout and artifacts as for playground_e2e.ts).
 */
import type { Page } from "playwright";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launchBrowser } from "../scripts/browser.ts";
import { ensureBundle } from "../scripts/serve.ts";
import { startPlaygroundServer } from "../src/serve.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

type PageYurt = {
  ready: Promise<unknown>;
  exec(command: string, opts?: { timeoutMs?: number }): Promise<{
    code: number | null;
    stdout: string;
    stderr: string;
  }>;
};

/** The terminal's non-empty lines, trimmed. */
const lines = (page: Page) =>
  page.evaluate(() =>
    Array.from(
      document.querySelectorAll("#term .xterm-rows > div"),
      (row) => (row.textContent ?? "").replace(/ /g, " ").trim(),
    ).filter((line) => line !== "")
  );

async function waitForLines(
  page: Page,
  what: string,
  ok: (lines: string[]) => boolean,
  timeoutMs = 60_000,
): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  let seen = await lines(page);
  while (!ok(seen)) {
    if (Date.now() > deadline) {
      throw new Error(`${what}; terminal: ${seen.join(" | ")}`);
    }
    await page.waitForTimeout(100);
    seen = await lines(page);
  }
  return seen;
}

/**
 * Type `command` after `clear` and resolve once a line reads `expect`; throw
 * at once if it fails. Markers are computed (`echo ok-$((6*7))` prints
 * `ok-42`), so the typed line, even wrapped, never matches one.
 */
async function typed(
  page: Page,
  command: string,
  expect: string,
  timeoutMs = 60_000,
) {
  await waitForLines(page, "prompt", (s) => /[$#]$/.test(s.at(-1) ?? ""));
  const start = performance.now();
  await page.keyboard.type(`clear; ${command} || echo failed-$((6*7))\n`);
  const seen = await waitForLines(
    page,
    `"${command}" printed "${expect}"`,
    (seen) => seen.includes(expect) || seen.includes("failed-42"),
    timeoutMs,
  );
  if (!seen.includes(expect)) {
    throw new Error(`"${command}" failed; terminal: ${seen.join(" | ")}`);
  }
  console.log(
    `terminal: ${command} -> ${expect} (${
      (performance.now() - start).toFixed(0)
    } ms incl. typing)`,
  );
}

if (import.meta.main) {
  await ensureBundle(
    Deno.env.get("YURT_KERNEL_ROOT") ?? join(repoRoot, "../yurtos-kernel"),
  );
  const server = startPlaygroundServer(0);
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    page.on("pageerror", (error) => console.error("pageerror:", error));
    await page.goto(`${server.url}/?start`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(
      () => (globalThis as { yurt?: unknown }).yurt !== undefined,
      null,
      { timeout: 120_000 },
    );
    const exec = (command: string) =>
      page.evaluate(async (command) => {
        const t = performance.now();
        const r = await (globalThis as unknown as { yurt: PageYurt }).yurt
          .exec(command, { timeoutMs: 120_000 });
        return { ...r, ms: performance.now() - t };
      }, command);
    await page.evaluate(() =>
      (globalThis as unknown as { yurt: PageYurt }).yurt.ready
    );

    await page.locator("#term").click();
    await typed(
      page,
      "sudo pkg update && sudo pkg install yurtos-x86 && echo pkg-ok-$((6*7))",
      "pkg-ok-42",
      300_000,
    );
    await typed(page, "yurtos-x86 hello", "hello, world");
    await typed(page, "yurtos-x86 busybox echo x86-$((6*7))", "x86-42");
    // x86 ash captures a command substitution (the sandbox's Wasm busybox).
    await typed(
      page,
      "yurtos-x86 busybox sh -c 'x=$(busybox echo sub); echo x86-$x'",
      "x86-sub",
    );

    // Each case's exact stdout; stderr must stay empty.
    const cases: [string, string][] = [
      ["yurtos-x86 hello", "hello, world\n"],
      ["yurtos-x86 busybox echo hi", "hi\n"],
      ["yurtos-x86 busybox uname -s", "Linux\n"],
      ["yurtos-x86 busybox head -n1 /etc/os-release", 'NAME="Yurt"\n'],
      // x86 ash piping into the sandbox's own (Wasm) head: bare names in an
      // x86 shell are the sandbox's programs (PATH), not YURTOS_X86_PATH.
      [
        "yurtos-x86 busybox sh -c 'printf \"a\\nb\\nc\\n\" | head -n 2'",
        "a\nb\n",
      ],
      // A Wasm program piping into an x86 one.
      ["printf 'a\\nb\\n' | yurtos-x86 busybox head -n 1", "a\n"],
      [
        "yurtos-x86 busybox sh -c 'i=0; while [ $i -lt 1000 ]; do i=$((i+1)); done; echo $i'",
        "1000\n",
      ],
      // x86 ash forks and execs an x86 program, three times.
      [
        "yurtos-x86 busybox sh -c 'for i in 1 2 3; do /usr/lib/yurtos-x86/bin/busybox echo x$i || exit 1; done'",
        "x1\nx2\nx3\n",
      ],
    ];
    const failures: string[] = [];
    for (const [command, stdout] of cases) {
      const r = await exec(command);
      console.log(
        `exec: ${command} -> code ${r.code} ${r.ms.toFixed(0)} ms ${
          JSON.stringify(r.stdout)
        }`,
      );
      if (r.code !== 0 || r.stdout !== stdout || r.stderr !== "") {
        failures.push(`${command}: code ${r.code} ${JSON.stringify(r)}`);
      }
    }
    if (failures.length > 0) throw new Error(failures.join("\n"));
    console.log("x86 scene: ok");
  } finally {
    await browser.close();
    await server.shutdown();
  }
}
