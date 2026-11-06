/**
 * The agent pane on a real model outside the browser. Nothing is stubbed: real
 * Chrome (Playwright's `chrome` channel), the page's real sandbox and real
 * Ollama. The scene is the demo: the pane connects, the model writes an
 * explanation of the demo into a PDF in the sandbox, then changes it when asked
 * in the chat, and a real PDF reader (macOS PDFKit) checks both versions.
 *
 * Not in CI: GitHub's runners have neither Ollama nor its models. Run it on a
 * Mac, with `ollama serve` running:
 *
 *   deno run --allow-all tests/agent_ollama_e2e.ts [--model gemma4:e4b] \\
 *     [--runs 1] [--out <dir>] [--headed] [--stage-mkpdf <file>]
 */
import { chromium, type Page } from "playwright";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureBundle } from "../scripts/serve.ts";
import { listOllamaModels, OLLAMA_URL } from "../src/ollama.ts";
import { startPlaygroundServer } from "../src/serve.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const flag = (name: string) => {
  const at = Deno.args.indexOf(`--${name}`);
  return at < 0 ? undefined : Deno.args[at + 1];
};
const RUNS = Number(flag("runs") ?? 1);
const OUT = flag("out") ?? await Deno.makeTempDir({ prefix: "agent-ollama-" });
/** A local copy of the `mkpdf` command, placed in the sandbox instead of
 * installing the package: for a port not yet published. */
const STAGE = flag("stage-mkpdf");
const EDIT = "Thanks for trying Yurt.";

/** The text a real PDF reader finds in the file. */
async function pdfText(path: string): Promise<string> {
  const script = `import PDFKit
guard let doc = PDFDocument(url: URL(fileURLWithPath: CommandLine.arguments[1])) else {
  print("UNREADABLE"); exit(1)
}
print(doc.pageCount, doc.string ?? "")
`;
  const source = await Deno.makeTempFile({ suffix: ".swift" });
  await Deno.writeTextFile(source, script);
  const { stdout, stderr } = await new Deno.Command("swift", {
    args: [source, path],
  }).output();
  await Deno.remove(source);
  const decode = new TextDecoder();
  return decode.decode(stdout) + decode.decode(stderr).slice(0, 300);
}

type Yurtish = {
  ready: Promise<void>;
  exec(c: string, o?: { stdin?: string }): Promise<{ code: number | null }>;
  fs: { read(p: string): Promise<Uint8Array> };
};

/** Send one message and wait for its end: an answer or a stop more than before,
 * with the sandbox suspended. A message after the first reloads the page to
 * resume it, so this looks again across the reload. */
async function say(page: Page, message: string): Promise<number> {
  const started = performance.now();
  const ends = "#agent-transcript .answer, #agent-transcript .stopped";
  const before = await page.locator(ends).count();
  await page.locator("[data-testid=agent-task]").fill(message);
  await page.locator("[data-testid=agent-run]").click();
  while (performance.now() - started < 600_000) {
    const done = await page.evaluate(
      ([ends, before]) =>
        document.querySelectorAll(ends as string).length > (before as number) &&
        document.querySelector("#agent")?.hasAttribute(
            "data-agent-suspended",
          ) ===
          true,
      [ends, before] as const,
    ).catch(() => false);
    if (done) return performance.now() - started;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`no end to: ${message}`);
}

/** The PDF as the visitor gets it: the sandbox is sealed by now. */
async function readBack(page: Page, name: string): Promise<Uint8Array> {
  const button = page.locator("[data-testid=agent-download]");
  if (await button.count() === 0) return new Uint8Array();
  const saving = page.waitForEvent("download", { timeout: 30_000 });
  await button.click();
  const bytes = await Deno.readFile(await (await saving).path());
  await Deno.writeFile(join(OUT, `${name}.pdf`), bytes);
  return bytes;
}

async function readerText(name: string, bytes: Uint8Array): Promise<string> {
  return bytes.length === 0 ? "" : await pdfText(join(OUT, `${name}.pdf`));
}

/** The demo: the model writes the explanation, then changes it when asked. */
async function runDemo(page: Page, name: string): Promise<boolean> {
  const task = await page.locator("[data-testid=agent-task]").inputValue();
  const firstMs = await say(page, task);
  const first = await readerText(
    `${name}-first`,
    await readBack(page, `${name}-first`),
  );
  const secondMs = await say(page, `Add a last line saying exactly: ${EDIT}`);
  const secondBytes = await readBack(page, `${name}-second`);
  const second = await readerText(`${name}-second`, secondBytes);
  const pinkMs = await say(page, "make it pink");
  const pinkBytes = await readBack(page, `${name}-pink`);
  const rg = /BT \/F1 12 Tf ([\d.]+) ([\d.]+) ([\d.]+) rg/.exec(
    new TextDecoder().decode(pinkBytes),
  )?.slice(1).map(Number) ?? [0, 0, 0];
  const pink = rg[0] > 0.8 && rg[1] < rg[0] && rg[2] > rg[1];
  const stops = await page.locator("#agent-transcript .stopped").count();
  console.log(
    `${name}: pink=${pink} rgb=${rg} (${
      Math.round(pinkMs / 1000)
    } s) stops=${stops}`,
  );
  await Deno.writeTextFile(
    join(OUT, `${name}.txt`),
    await page.locator("#agent-transcript").innerText(),
  );
  await page.locator("#agent").screenshot({
    path: join(OUT, `${name}.png`),
  });
  const flat = (t: string) => t.replace(/\s+/g, " ");
  const wrote = first.startsWith("1 ") && first.length > 200 &&
    /yurt/i.test(first);
  const changed = flat(second).includes(EDIT);
  // The edit kept the document: most of the first version's words survive.
  const words = new Set(flat(second).toLowerCase().split(" "));
  const firstWords = flat(first).toLowerCase().split(" ");
  const kept = firstWords.filter((w) => words.has(w)).length /
    Math.max(firstWords.length, 1);
  console.log(
    `${name}: wrote=${wrote} (${first.length} chars, ${
      Math.round(firstMs / 1000)
    } s) changed=${changed} kept=${Math.round(kept * 100)}% (${
      Math.round(secondMs / 1000)
    } s)`,
  );
  return wrote && changed && kept > 0.9 && pink;
}

if (import.meta.main) {
  const models = await listOllamaModels();
  const model = flag("model") ?? models[0];
  if (!models.includes(model)) throw new Error(`${model} is not installed`);
  await ensureBundle(
    Deno.env.get("YURT_KERNEL_ROOT") ?? join(repoRoot, "../yurtos-kernel"),
  );
  const server = startPlaygroundServer(0);
  const browser = await chromium.launch({
    channel: "chrome",
    headless: !Deno.args.includes("--headed"),
  });
  let passed = 0;
  try {
    for (let run = 1; run <= RUNS; run++) {
      const context = await browser.newContext();
      const page = await context.newPage();
      const ollamaRequests: string[] = [];
      page.on("request", (r) => {
        if (r.url().startsWith(OLLAMA_URL)) ollamaRequests.push(r.url());
      });
      await page.goto(`${server.url}/#agent`);
      await page.locator("[data-testid=agent-model]").selectOption("ollama");
      await page.waitForTimeout(500);
      if (ollamaRequests.length !== 0) {
        throw new Error("the page contacted Ollama before Connect");
      }
      await page.locator("[data-testid=agent-start]").click();
      await page.locator("#agent[data-agent-ready]").waitFor();
      await page.locator("[data-testid=agent-installed]").selectOption(model);
      page.on("console", (m) => {
        if (/\[(snapshot|session)\]/.test(m.text())) {
          console.log(m.text().slice(0, 160));
        }
      });
      const stage = STAGE === undefined ? "" : await Deno.readTextFile(STAGE);
      const startMs = await page.evaluate(async (stage) => {
        const started = performance.now();
        const yurt = (globalThis as unknown as { yurt: Yurtish }).yurt;
        document.getElementById("start-sandbox")?.click();
        await yurt.ready;
        const ms = performance.now() - started;
        if (stage !== "") {
          const r = await yurt.exec(
            "sudo tee /usr/bin/mkpdf >/dev/null && sudo chmod 755 /usr/bin/mkpdf",
            { stdin: stage },
          );
          if (r.code !== 0) throw new Error("could not place mkpdf");
        }
        return ms;
      }, stage);
      console.log(`sandbox ready in ${(startMs / 1000).toFixed(1)} s`);
      const name = `${model.replace(/\W/g, "-")}-${run}`;
      if (await runDemo(page, name)) passed++;
      await context.close();
    }
  } finally {
    await browser.close();
    await server.shutdown();
  }
  console.log(`agent ollama e2e: ${model}: ${passed}/${RUNS}; files in ${OUT}`);
  if (passed !== RUNS) Deno.exit(1);
}
