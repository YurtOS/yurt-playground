/**
 * The agent pane on a real model outside the browser. Nothing is stubbed: real
 * Chrome (Playwright's `chrome` channel), the page's real sandbox and real
 * Ollama. The scene is the demo: the pane connects, the agent installs the
 * `mkpdf` package and makes a PDF in the sandbox, and a real PDF reader (macOS
 * PDFKit) finds the text in it.
 *
 * Not in CI: GitHub's runners have neither Ollama nor its models. Run it on a
 * Mac, with `ollama serve` running:
 *
 *   deno run --allow-all tests/agent_ollama_e2e.ts [--model gemma4:e4b] \\
 *     [--runs 1] [--out <dir>] [--headed]
 */
import { chromium, type Page } from "playwright";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureBundle } from "../scripts/serve.ts";
import { DEMO_PDF_PATH, DEMO_PDF_TEXT } from "../src/agent.ts";
import { listOllamaModels, OLLAMA_URL } from "../src/ollama.ts";
import { startPlaygroundServer } from "../src/serve.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const flag = (name: string) => {
  const at = Deno.args.indexOf(`--${name}`);
  return at < 0 ? undefined : Deno.args[at + 1];
};
const RUNS = Number(flag("runs") ?? 1);
const OUT = flag("out") ?? await Deno.makeTempDir({ prefix: "agent-ollama-" });

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

async function transcript(page: Page): Promise<string> {
  return await page.locator("#agent-transcript").innerText();
}

/** One task to its end; what the reader found, and the transcript. */
async function runDemo(page: Page, name: string): Promise<boolean> {
  await page.locator("[data-testid=agent-run]").click();
  await page.waitForFunction(
    () =>
      document.querySelector(
        "#agent-transcript .answer, #agent-transcript .stopped",
      ) !==
        null,
    null,
    { timeout: 600_000, polling: 250 },
  );
  const steps = await page.locator("#agent-transcript li.step").count();
  const bytes = await page.evaluate(
    (path) =>
      (globalThis as unknown as {
        yurt: { fs: { read(p: string): Promise<Uint8Array> } };
      }).yurt.fs.read(path).then((b) => [...b]).catch(() => null),
    DEMO_PDF_PATH,
  );
  const text = await transcript(page);
  await Deno.writeTextFile(join(OUT, `${name}.txt`), text);
  if (bytes === null) {
    console.log(`${name}: NO FILE after ${steps} steps`);
    return false;
  }
  const path = join(OUT, `${name}.pdf`);
  await Deno.writeFile(path, new Uint8Array(bytes));
  const found = await pdfText(path);
  const ok = found.includes(DEMO_PDF_TEXT) && found.startsWith("1 ");
  console.log(
    `${name}: ${
      ok ? "PASS" : "FAIL"
    }, ${steps} steps, ${bytes.length} bytes, reader: ${
      JSON.stringify(found.slice(0, 120))
    }`,
  );
  return ok;
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
      await page.goto(`${server.url}/`);
      await page.locator("[data-testid=agent-model]").selectOption("ollama");
      await page.waitForTimeout(500);
      if (ollamaRequests.length !== 0) {
        throw new Error("the page contacted Ollama before Connect");
      }
      await page.locator("[data-testid=agent-start]").click();
      await page.locator("#agent[data-agent-ready]").waitFor();
      await page.locator("[data-testid=agent-installed]").selectOption(model);
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
