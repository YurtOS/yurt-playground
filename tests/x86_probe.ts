/**
 * Local probe: boot the playground in Chrome (scripts/browser.ts), upload the
 * yurtos-x86 emulator and x86-64 ELFs through window.yurt.fs, and time
 * commands. X86_WASM, X86_BINS (dir), X86_CMDS (newline-separated) select
 * what runs. X86_SKIP_UPLOAD=1 uploads nothing: X86_CMDS can install the
 * published package first (`sudo pkg update && sudo pkg install yurtos-x86`).
 *
 *   deno run -A tests/x86_probe.ts
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Buffer } from "node:buffer";
import { launchBrowser } from "../scripts/browser.ts";
import { ensureBundle } from "../scripts/serve.ts";
import { startPlaygroundServer } from "../src/serve.ts";

const D = Deno.env.get("X86_DIR") ?? "/home/user/x86";
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

type R = {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
};

await ensureBundle(
  Deno.env.get("YURT_KERNEL_ROOT") ?? join(repoRoot, "../yurtos-kernel"),
);
const server = startPlaygroundServer(0);
const browser = await launchBrowser();
const t0 = performance.now();
try {
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.error("pageerror:", e));
  page.on("console", (m) => {
    if (Deno.env.get("X86_CONSOLE")) console.log("console:", m.text());
  });
  await page.goto(`${server.url}/?start`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => (globalThis as { yurt?: unknown }).yurt !== undefined,
    null,
    { timeout: 120_000 },
  );
  const ready = await page.evaluate(() =>
    // deno-lint-ignore no-explicit-any
    (globalThis as any).yurt.ready.then(() => "ready", (e: unknown) => `${e}`)
  );
  console.log(`boot: ${ready} in ${(performance.now() - t0).toFixed(0)} ms`);
  if (ready !== "ready") throw new Error(ready);
  const exec = (cmd: string, timeoutMs = 120_000) =>
    page.evaluate(async ([cmd, timeoutMs]) => {
      const t = performance.now();
      // deno-lint-ignore no-explicit-any
      const r = await (globalThis as any).yurt.exec(cmd, { timeoutMs });
      return { ...r, ms: performance.now() - t };
    }, [cmd, timeoutMs] as const) as Promise<R & { ms: number }>;
  const write = async (path: string, bytes: Uint8Array, mode: number) => {
    const t = performance.now();
    await page.evaluate(async ([path, b64, mode]) => {
      const bin = atob(b64);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      // deno-lint-ignore no-explicit-any
      await (globalThis as any).yurt.fs.write(path, out, { mode });
    }, [path, Buffer.from(bytes).toString("base64"), mode] as const);
    console.log(
      `wrote ${path} (${bytes.length} B) in ${
        (performance.now() - t).toFixed(0)
      } ms`,
    );
  };
  console.log(
    JSON.stringify(
      await exec("uname -a; id; ls -ld / /work /usr/local/bin 2>&1"),
    ),
  );
  if (!Deno.env.get("X86_SKIP_UPLOAD")) {
    const wasm = Deno.env.get("X86_WASM")!;
    const bins = Deno.env.get("X86_BINS")!;
    await exec(`mkdir -p ${D}`);
    await write(`${D}/yurtos-x86`, await Deno.readFile(wasm), 0o755);
    for (
      const name of (Deno.env.get("X86_BIN_NAMES") ?? "hello busybox").split(
        " ",
      )
    ) {
      await write(`${D}/${name}`, await Deno.readFile(join(bins, name)), 0o755);
    }
  }
  const cmds = (Deno.env.get("X86_CMDS") ?? "").split("\n").filter((c) => c);
  for (const cmd of cmds) {
    const r = await exec(
      cmd,
      Number(Deno.env.get("X86_TIMEOUT_MS") ?? 120_000),
    );
    console.log(
      `\n$ ${cmd}\n  -> code=${r.code} signal=${r.signal} timedOut=${r.timedOut} ${
        r.ms.toFixed(0)
      } ms\n  stdout=${JSON.stringify(r.stdout.slice(0, 600))}\n  stderr=${
        JSON.stringify(r.stderr.slice(0, 600))
      }`,
    );
  }
} finally {
  await browser.close();
  await server.shutdown();
}
