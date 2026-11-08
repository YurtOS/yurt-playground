/**
 * The agent pane on the real in-tab model. Nothing is stubbed: real Chrome
 * (Playwright's `chrome` channel), the real WebGPU inference worker and
 * Gemma 4 weights from Hugging Face, and the page's real sandbox. The scene is
 * the demo: the model writes an explanation of the demo into a PDF in the
 * sandbox, changes it when asked in the chat, colors it, counts its words with
 * a command, and writes a second PDF from a Python step; a real PDF reader
 * (macOS PDFKit) checks each version. The weights stay in one Chrome profile
 * under ~/Library/Caches/yurt-playground/, so they download once.
 *
 * Not in CI: GitHub's runners have no GPU. Run it on a Mac:
 *
 *   deno run --allow-all tests/agent_demo_e2e.ts [--model E4B|E2B] \
 *     [--runs 1] [--out <dir>] [--headed] [--stage-mkpdf <file>]
 */
import { chromium, type Page } from "playwright";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureBundle } from "../scripts/serve.ts";
import { LOCAL_MODELS } from "../src/llm_models.ts";
import { startPlaygroundServer } from "../src/serve.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const flag = (name: string) => {
  const at = Deno.args.indexOf(`--${name}`);
  return at < 0 ? undefined : Deno.args[at + 1];
};
const RUNS = Number(flag("runs") ?? 1);
const OUT = flag("out") ?? await Deno.makeTempDir({ prefix: "agent-demo-" });
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
  const file = name.endsWith("-fact") ? "fact.pdf" : "demo.pdf";
  const button = page.locator(
    `[data-testid=agent-download][data-file="${file}"]`,
  );
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
  const pink = rg[0] > 0.8 && rg[1] < rg[0] && rg[2] >= rg[1];
  // The model has to run this one: its number against a real reader's.
  const pinkText = (await readerText(`${name}-pink`, pinkBytes)).replace(
    /^1 /,
    "",
  );
  const wordCount = pinkText.trim().split(/\s+/).length;
  const countStarted = performance.now();
  await say(
    page,
    "Run this in the sandbox and tell me the number it prints: mkpdf --text /home/user/demo.pdf | wc -w",
  );
  const counted = await page.locator("#agent-transcript .answer").last()
    .innerText();
  const calls = await page.locator("#agent-transcript .call").allInnerTexts();
  const ranIt = calls.at(-1)?.includes("wc") === true;
  const countRight = new RegExp(`\\b${wordCount}\\b`).test(counted);
  console.log(
    `${name}: count right=${countRight} ran=${ranIt} truth=${wordCount} (${
      Math.round((performance.now() - countStarted) / 1000)
    } s) | ${JSON.stringify(calls.at(-1)?.slice(0, 70))} | ${
      JSON.stringify(counted.slice(0, 80))
    }`,
  );
  // A PDF under another name: real, and on offer beside the demo's.
  await say(
    page,
    `First run this: python3 -c "import math; print(math.factorial(10))". Then write only the number it printed to /home/user/fact.pdf.`,
  );
  const factBytes = await readBack(page, `${name}-fact`);
  const factText = await readerText(`${name}-fact`, factBytes);
  // From Python, not from the model's memory: the number alone proves nothing.
  const factCalls = await page.locator("#agent-transcript .call")
    .allInnerTexts();
  const ranPython = factCalls.slice(-3).some((c) => c.includes("python3"));
  const fact = ranPython && factText.includes("3628800") &&
    new TextDecoder().decode(factBytes.slice(0, 5)) === "%PDF-" &&
    await page.locator('[data-file="demo.pdf"]').count() === 1;
  console.log(
    `${name}: fact pdf=${fact} ran python=${ranPython} (${factBytes.length} bytes)`,
  );
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
  return wrote && changed && kept > 0.9 && pink && countRight && ranIt && fact;
}

if (import.meta.main) {
  const model = LOCAL_MODELS.find((m) => m.id === (flag("model") ?? "E4B"));
  if (model === undefined) {
    throw new Error(
      `--model is one of ${LOCAL_MODELS.map((m) => m.id).join(", ")}`,
    );
  }
  await ensureBundle(
    Deno.env.get("YURT_KERNEL_ROOT") ?? join(repoRoot, "../yurtos-kernel"),
  );
  // A fixed port, so the cached weights' origin is the same each time.
  const server = startPlaygroundServer(4184);
  // One profile, so the weights download once (Cache Storage); each run
  // clears everything else the page keeps.
  const context = await chromium.launchPersistentContext(
    join(
      Deno.env.get("HOME")!,
      "Library/Caches/yurt-playground/agent-demo-chrome",
    ),
    {
      channel: "chrome",
      headless: !Deno.args.includes("--headed"),
      args: ["--enable-unsafe-webgpu"],
    },
  );
  let passed = 0;
  try {
    for (let run = 1; run <= RUNS; run++) {
      const page = await context.newPage();
      await page.goto(`${server.url}/`);
      await page.evaluate(async () => {
        localStorage.clear();
        sessionStorage.clear();
        for (const db of await indexedDB.databases()) {
          if (db.name) indexedDB.deleteDatabase(db.name);
        }
        const root = await navigator.storage.getDirectory();
        // deno-lint-ignore no-explicit-any
        for await (const name of (root as any).keys()) {
          await root.removeEntry(name, { recursive: true });
        }
      });
      await page.goto(`${server.url}/#agent`);
      await page.locator("[data-testid=agent-model]").selectOption(model.id);
      const loading = performance.now();
      await page.locator("[data-testid=agent-start]").click();
      await page.locator("#agent[data-agent-ready]").waitFor({
        timeout: 20 * 60_000,
      });
      console.log(
        `${model.id} loaded in ${
          Math.round((performance.now() - loading) / 1000)
        } s (cached=${await page.locator("#agent").getAttribute(
          "data-agent-from-cache",
        )})`,
      );
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
      if (await runDemo(page, `${model.id}-${run}`)) passed++;
      await page.close();
    }
  } finally {
    await context.close();
    await server.shutdown();
  }
  console.log(
    `agent demo e2e: ${model.id}: ${passed}/${RUNS}; files in ${OUT}`,
  );
  if (passed !== RUNS) Deno.exit(1);
}
