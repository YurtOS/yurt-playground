/**
 * Browser acceptance for the Jupyter Notebook interface: the JupyterLite
 * frontend at /jupyter/ drives the real ipykernel inside the sandbox through
 * the Yurt kernel plugin. Also checks the home page's gating: a phone gets
 * the choices plus a note, its Notebook page boots no sandbox, and a page served without COOP/COEP lands on the
 * unsupported page. And that output runs no script in the page's origin
 * (yurt-sandbox#382): neither a guest's `display(Javascript(...))` nor the
 * stored outputs of a supplied notebook whose cells claim to be trusted.
 * And that HTML output cannot navigate or restyle the page: it renders in a
 * sandboxed frame that keeps its styling and fits its content.
 *
 * Run: deno run --allow-all tests/jupyterlite_e2e.ts (needs the pinned blobs
 * in artifacts/ and the site from jupyterlite/build.sh in public/jupyter/).
 */
import { Buffer } from "node:buffer";
import {
  type Browser,
  type BrowserContext,
  devices,
  type Page,
} from "playwright";
import { launchBrowser } from "../scripts/browser.ts";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureBundle } from "../scripts/serve.ts";
import { startPlaygroundServer } from "../src/serve.ts";
import { BRIDGE_STATUS_ID, PHONE_REFUSAL } from "../src/bridge_status.ts";
import { watchCspViolations } from "./csp_watch.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function fail(message: string): never {
  throw new Error(message);
}

/** Insert a cell below the active one, put `code` into it, and run it. The
 * code is inserted, not typed: typing goes through the editor's bracket and
 * quote auto-closing, which garbles a payload like `{...}` in a string. */
async function runNewCell(page: Page, code: string): Promise<void> {
  await page.keyboard.press("Escape");
  await page.keyboard.press("b");
  await page.keyboard.press("Enter");
  await page.keyboard.insertText(code);
  await page.keyboard.press("Shift+Enter");
}

/** Wait until the notebook's last output area contains `text` and no cell
 * is still running. */
async function waitForLastOutput(
  page: Page,
  text: string,
  timeout: number,
): Promise<void> {
  await page.waitForFunction(
    (want) => {
      const outputs = [...document.querySelectorAll(".jp-OutputArea-output")];
      const last = outputs.at(-1)?.textContent ?? "";
      const prompts = [...document.querySelectorAll(".jp-InputPrompt")]
        .map((node) => node.textContent ?? "");
      return last.includes(want) &&
        prompts.every((prompt) => !prompt.includes("*"));
    },
    text,
    { timeout },
  );
}

/** Wait until the toolbar names the Yurt kernel and it is idle. Before the
 * session starts the toolbar reads "No Kernel" with an idle indicator, so both
 * the name and the status are required. A sandbox that cannot start says so on
 * the page's status line (src/bridge_status.ts) and never becomes idle: that
 * fails at once, with the page's words, instead of at the timeout. */
async function waitForKernelIdle(page: Page, timeout: number): Promise<void> {
  const outcome = await page.waitForFunction(
    (statusId) => {
      const line = document.getElementById(statusId);
      const state = line?.dataset.state;
      if (state === "error" || state === "python-missing") {
        return `failed: ${line?.textContent ?? ""}`;
      }
      return document.querySelector(".jp-Toolbar-kernelName")?.textContent
              ?.includes("Yurt") === true &&
          document.querySelector(".jp-Notebook-ExecutionIndicator")
              ?.getAttribute("data-status") === "idle"
        ? "idle"
        : false;
    },
    BRIDGE_STATUS_ID,
    { timeout },
  );
  const result = await outcome.jsonValue();
  if (result !== "idle") {
    fail(`the notebook's sandbox did not start: ${result}`);
  }
}

/** A notebook someone hands the visitor: its cells claim to be trusted and
 * carry a JavaScript output and an HTML output with script in it. */
const TRUSTED_CLAIM_NOTEBOOK = {
  cells: [
    {
      cell_type: "code",
      execution_count: 1,
      metadata: { trusted: true },
      outputs: [{
        output_type: "display_data",
        metadata: {},
        data: {
          "application/javascript": "window.__trustedJs = 1;",
          "text/html":
            '<b id="trusted-html">x</b><script>window.__trustedJs = 2;</script>',
          "text/plain": "trusted-claim",
        },
      }],
      source: ["1"],
    },
  ],
  metadata: {
    kernelspec: {
      display_name: "Python 3 (Yurt sandbox)",
      language: "python",
      name: "yurt",
    },
  },
  nbformat: 4,
  nbformat_minor: 5,
};

/** Upload `notebook` through the file browser as `uploaded`, rename it to
 * `name` when they differ, and open it in a new page of `context`. */
async function openSupplied(
  context: BrowserContext,
  url: string,
  uploaded: string,
  name: string,
  notebook: unknown,
): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`${url}/jupyter/tree/index.html`, { waitUntil: "load" });
  await page.locator(".jp-DirListing").first().waitFor({ timeout: 60_000 });
  const chooser = page.waitForEvent("filechooser", { timeout: 20_000 });
  await page.locator('[title="Upload Files"]').first().click();
  await (await chooser).setFiles({
    name: uploaded,
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(notebook)),
  });
  const item = page.locator(".jp-DirListing-item", { hasText: uploaded });
  await item.waitFor({ timeout: 30_000 });
  if (uploaded !== name) {
    await item.click();
    await page.keyboard.press("F2");
    const editor = page.locator(".jp-DirListing-editor");
    await editor.fill(name);
    await editor.press("Enter");
    await page.locator(".jp-DirListing-item", { hasText: name }).waitFor({
      timeout: 30_000,
    });
  }
  await page.goto(
    `${url}/jupyter/notebooks/index.html?path=${name}`,
    { waitUntil: "load" },
  );
  await page.locator(".jp-Notebook").first().waitFor({ timeout: 60_000 });
  return page;
}

/** Upload {@link TRUSTED_CLAIM_NOTEBOOK} through the file browser as
 * `uploaded`, rename it to `name` when they differ, open it, and fail if its
 * stored output rendered as trusted. The flag is the file's word only:
 * JupyterLite has no notebook signatures to back it. A file uploaded under
 * another extension keeps its stored type when renamed to .ipynb, and the
 * notebook still opens from it. */
async function checkTrustedClaimIgnored(
  browser: Browser,
  url: string,
  uploaded: string,
  name: string,
): Promise<void> {
  const context = await browser.newContext();
  const page = await openSupplied(
    context,
    url,
    uploaded,
    name,
    TRUSTED_CLAIM_NOTEBOOK,
  );
  await page.locator(".jp-OutputArea-output").first().waitFor({
    timeout: 60_000,
  });
  const rendered = await page.evaluate(() => ({
    js: (globalThis as { __trustedJs?: number }).__trustedJs,
    trusted: document.querySelectorAll(".jp-OutputArea-output.jp-mod-trusted")
      .length,
    raw: document.getElementById("trusted-html") !== null,
  }));
  if (rendered.js !== undefined || rendered.trusted > 0 || rendered.raw) {
    fail(
      `a supplied notebook's stored output rendered as trusted (${uploaded} opened as ${name}): ${
        JSON.stringify(rendered)
      }`,
    );
  }
  await context.close();
}

/** HTML outputs that reload their frame forever wherever a meta refresh may
 * run: a self-refresh, ones a template parse would miss (`<col>`,
 * `<noscript>` parsed with scripting on), and nested srcdoc frames, one with
 * its name entity-encoded and one in a closed shadow root, where neither the
 * page nor the frame can see it. Each reports every load of its documents as
 * an image the frame's policy refuses (both browsers forward that report to
 * the page's console). */
const SELF_REFRESH = '<meta http-equiv="refresh" content="0">';
const nestedRefresh = (name: string, tag: string) =>
  `<iframe srcdoc="<meta ${name}=refresh content=0><img src=https://leak.example/?reload-probe-${tag}>"></iframe>`;
const RELOAD_PROBES = [
  SELF_REFRESH,
  `<col>${SELF_REFRESH}`,
  `<noscript><style></noscript>${SELF_REFRESH}</style></noscript>`,
  nestedRefresh("http&#45;equiv", "nested"),
  `<div><template shadowrootmode="closed">${
    nestedRefresh("http-equiv", "shadow")
  }</template></div>`,
].map((payload, i) =>
  `<img src="https://leak.example/?reload-probe-${i}">${payload}`
);

/** A notebook someone shares: `outputs` stored, or none and code that makes
 * the same outputs when the visitor runs it. */
function sharedNotebook(stored: boolean): unknown {
  return {
    ...TRUSTED_CLAIM_NOTEBOOK,
    cells: [{
      cell_type: "code",
      execution_count: stored ? 1 : null,
      metadata: {},
      outputs: stored
        ? RELOAD_PROBES.map((html) => ({
          output_type: "display_data",
          metadata: {},
          data: { "text/html": html, "text/plain": "reload-probe" },
        }))
        : [],
      source: [
        "from IPython.display import HTML\n",
        `for h in ${JSON.stringify(RELOAD_PROBES)}: display(HTML(h))\n`,
      ],
    }],
  };
}

/** Counts every load the reload probes report in `context`. */
function watchReloads(context: BrowserContext) {
  const seen = new Set<string>();
  const watch = { seen, loads: 0 };
  context.on("console", (message) => {
    const probe = /reload-probe-(\w+)/.exec(message.text());
    if (probe === null) return;
    watch.loads++;
    seen.add(probe[1]);
  });
  return watch;
}

/** Wait until every probe has rendered (`raw`: the nested ones too, which
 * only unsanitized output has), then fail if any frame loads again in the
 * next 2 s, if the page left, or if a request left. */
async function checkSettles(
  page: Page,
  watch: { seen: Set<string>; loads: number },
  leaks: string[],
  what: string,
  raw: boolean,
): Promise<void> {
  const url = page.url();
  const want = [
    ...RELOAD_PROBES.map((_, i) => String(i)),
    ...(raw ? ["nested", "shadow"] : []),
  ];
  const deadline = Date.now() + 120_000;
  // The reports alone could come from the first-height guess, which lays
  // the sanitized markup out in the page: a frame per probe must exist too.
  const framed = () =>
    page.locator(".yurt-OutputFrame iframe").count().then((n) =>
      n >= RELOAD_PROBES.length
    );
  while (!want.every((tag) => watch.seen.has(tag)) || !(await framed())) {
    if (Date.now() > deadline) {
      fail(`${what}: the reload probes did not all render: ${[...watch.seen]}`);
    }
    await page.waitForTimeout(250);
  }
  await page.waitForTimeout(1_000);
  watch.loads = 0;
  await page.waitForTimeout(2_000);
  if (watch.loads > 0 || page.url() !== url || leaks.length > 0) {
    fail(
      `${what}: frames loaded ${watch.loads} more times in 2 s; page ${page.url()}; requests ${leaks}`,
    );
  }
}

/** Requests that reach the network for leak.example (a refused load never
 * gets here). */
async function routeLeaks(context: BrowserContext): Promise<string[]> {
  const leaks: string[] = [];
  await context.route("https://leak.example/**", (route) => {
    leaks.push(route.request().url());
    return route.fulfill({ contentType: "text/html", body: "leaked" });
  });
  return leaks;
}

/**
 * A notebook someone shares can't make any frame reload itself
 * (yurt-sandbox#382, the owner's finding on #360), whether its HTML comes
 * from stored outputs (rendered sanitized), fresh outputs of its code under
 * Run All, or the stored outputs once the visitor trusts the notebook (both
 * rendered raw).
 */
async function checkSharedNotebookSettles(
  browser: Browser,
  url: string,
): Promise<void> {
  const context = await browser.newContext();
  const watch = watchReloads(context);
  const leaks = await routeLeaks(context);
  const stored = await openSupplied(
    context,
    url,
    "shared-stored.ipynb",
    "shared-stored.ipynb",
    sharedNotebook(true),
  );
  await checkSettles(
    stored,
    watch,
    leaks,
    "a shared notebook's stored output",
    false,
  );
  const page = await openSupplied(
    context,
    url,
    "shared-code.ipynb",
    "shared-code.ipynb",
    sharedNotebook(false),
  );
  await waitForKernelIdle(page, 480_000);
  watch.seen.clear();
  await page.locator(".lm-MenuBar-itemLabel", { hasText: /^Run$/ }).click();
  await page.locator(".lm-Menu-itemLabel", { hasText: /^Run All Cells$/ })
    .click();
  await checkSettles(page, watch, leaks, "a shared notebook's Run All", true);
  await page.close();
  await stored.bringToFront();
  await stored.locator(".lm-MenuBar-itemLabel", { hasText: /^File$/ }).click();
  await stored.locator(".lm-Menu-itemLabel", { hasText: /^Trust Notebook$/ })
    .click();
  watch.seen.clear();
  await stored.locator(".jp-Dialog button.jp-mod-accept").click();
  await checkSettles(stored, watch, leaks, "the same output, trusted", true);
  await context.close();
}

/** What pandas' `Styler._repr_html_` emits for a two-row table with one
 * highlighted cell: a `<style>` block keyed on the table's generated ids. */
const STYLER_HTML = `<style type="text/css">
#T_yurt_row1_col1 {
  background-color: #ffd54f;
}
#T_yurt caption { font-weight: bold; }
</style>
<table id="T_yurt">
  <caption>styler-probe</caption>
  <thead><tr><th class="blank level0">&nbsp;</th><th id="T_yurt_level0_col0" class="col_heading level0 col0">city</th><th id="T_yurt_level0_col1" class="col_heading level0 col1">temp</th></tr></thead>
  <tbody>
    <tr><th id="T_yurt_level0_row0" class="row_heading level0 row0">0</th><td id="T_yurt_row0_col0" class="data row0 col0">Oslo</td><td id="T_yurt_row0_col1" class="data row0 col1">3.5</td></tr>
    <tr><th id="T_yurt_level0_row1" class="row_heading level0 row1">1</th><td id="T_yurt_row1_col0" class="data row1 col0">Pune</td><td id="T_yurt_row1_col1" class="data row1 col1">31.2</td></tr>
  </tbody>
</table>`;

/** Every way an output could make the browser fetch something without a
 * click: images, CSS `url()` in a rule, an attribute and an `@import`, link
 * hints, a poster, a meta refresh. */
const REQUEST_PROBE = [
  '<img src="https://leak.example/?request-img">',
  '<img srcset="https://leak.example/?request-srcset 1x">',
  '<div style="background:url(https://leak.example/?request-attr)">a</div>',
  "<style>@import url(https://leak.example/?request-import);",
  ".r{background:url(https://leak.example/?request-rule)}</style>",
  '<div class="r">b</div>',
  '<link rel="stylesheet" href="https://leak.example/?request-css">',
  '<link rel="prefetch" href="https://leak.example/?request-prefetch">',
  '<link rel="preload" as="image" href="https://leak.example/?request-preload">',
  '<link rel="preconnect" href="https://leak.example/">',
  '<link rel="dns-prefetch" href="https://leak.example/">',
  '<video poster="https://leak.example/?request-poster"></video>',
  '<meta http-equiv="refresh" content="0;url=https://leak.example/?request-refresh">',
  "request-probe",
].join("");

/** A table taller and one wider than any first height and width. */
const LONG_TABLE = "<table>" +
  Array.from({ length: 80 }, (_, i) => `<tr><td>row ${i}</td></tr>`).join("") +
  "</table>";
const WIDE_TABLE = "<table><tr>" +
  Array.from({ length: 40 }, (_, i) => `<td>column-${i}-value</td>`).join("") +
  "</tr></table>";

/** The last output frame's wrapper, frame and document metrics. */
async function lastFrame(page: Page) {
  const wrapper = page.locator(".yurt-OutputFrame").last();
  const handle = await wrapper.locator("iframe").elementHandle();
  const document = (await handle!.contentFrame())!;
  return { wrapper, document };
}

/**
 * Guest HTML output stays inside a sandboxed frame that runs no script
 * (yurt-sandbox#382): no request leaves for anything in it, a meta refresh
 * neither navigates the page nor anything else, a `<style>` does not restyle
 * the page, a pandas Styler table keeps its CSS, and long and wide output
 * scrolls in a frame whose height the visitor drags. Markdown output carries
 * the same payloads and renders sanitized.
 */
async function checkHtmlOutputIsolation(page: Page): Promise<void> {
  const notebookUrl = page.url();
  const leaks = await routeLeaks(page.context());
  // Any finished request off the site's origin.
  const origin = new URL(notebookUrl).origin;
  const left: string[] = [];
  const onRequest = (request: { url(): string }) => {
    if (!request.url().startsWith(origin)) left.push(request.url());
  };
  page.on("requestfinished", onRequest);
  await runNewCell(
    page,
    `from IPython.display import HTML, Markdown; display(HTML(${
      JSON.stringify(REQUEST_PROBE)
    })); display(Markdown(${
      JSON.stringify(REQUEST_PROBE)
    })); print("request-probe", "done")`,
  );
  // Swallowed here only so a red run, whose page has left, fails below with
  // the page's URL; the output is asserted after that.
  await waitForLastOutput(page, "request-probe done", 60_000).catch(() => {});
  await page.waitForTimeout(3_000);
  page.off("requestfinished", onRequest);
  if (page.url() !== notebookUrl || leaks.length > 0 || left.length > 0) {
    fail(
      `an output left the page or made requests: ${page.url()}, ${[
        ...new Set([...leaks, ...left]),
      ]}`,
    );
  }
  await waitForLastOutput(page, "request-probe done", 1_000);
  await page.locator(".jp-CodeCell:has(.jp-OutputArea-output)").last()
    .locator(".yurt-OutputFrame iframe").first()
    .waitFor({ timeout: 1_000 })
    .catch(() => fail("the request probe's HTML output has no frame"));

  const style =
    "<style>body{background:rgb(1, 2, 3) !important}.jp-Notebook{outline:9px solid rgb(4, 5, 6)}</style>";
  await runNewCell(
    page,
    `from IPython.display import HTML, Markdown; display(HTML('${style}style-probe')); display(Markdown('${style}')); print("style-probe", "done")`,
  );
  await waitForLastOutput(page, "style-probe done", 60_000);
  await page.waitForTimeout(1_000);
  const restyled = await page.evaluate(() => ({
    body: getComputedStyle(document.body).backgroundColor,
    notebook: getComputedStyle(document.querySelector(".jp-Notebook")!)
      .outlineColor,
  }));
  if (
    restyled.body === "rgb(1, 2, 3)" || restyled.notebook === "rgb(4, 5, 6)"
  ) {
    fail(`a guest's <style> restyled the page: ${JSON.stringify(restyled)}`);
  }
  // A one-line output is a small frame, not a big empty box.
  const short = await (await lastFrame(page)).wrapper.evaluate((node) =>
    node.getBoundingClientRect().height
  );
  if (short > 60) fail(`a one-line output's frame is ${short}px tall`);

  await runNewCell(
    page,
    `from IPython.display import HTML, Markdown; display(HTML(${
      JSON.stringify(STYLER_HTML)
    })); print("styler-probe", "done")`,
  );
  await waitForLastOutput(page, "styler-probe done", 60_000);
  const styler = await lastFrame(page);
  const sandbox = await styler.wrapper.locator("iframe").getAttribute(
    "sandbox",
  );
  if (sandbox !== "allow-popups allow-popups-to-escape-sandbox") {
    fail(`the output frame's sandbox is "${sandbox}"`);
  }
  const font = await page.evaluate(() =>
    getComputedStyle(document.querySelector(".jp-MarkdownOutput")!).fontFamily
  );
  const inner = await styler.document.evaluate(() => ({
    cell: getComputedStyle(document.getElementById("T_yurt_row1_col1")!)
      .backgroundColor,
    font: getComputedStyle(document.querySelector(".yurt-frame-body")!)
      .fontFamily,
    // Its own policy, on top of the page's that a srcdoc frame inherits.
    policy: document.querySelector<HTMLMetaElement>(
      'meta[http-equiv="Content-Security-Policy"]',
    )?.content ?? "",
    origin: (() => {
      try {
        return localStorage.length >= 0 ? "storage reachable" : "";
      } catch {
        return "opaque";
      }
    })(),
  }));
  if (inner.cell !== "rgb(255, 213, 79)") {
    fail(`the Styler table lost its CSS: highlighted cell is ${inner.cell}`);
  }
  if (inner.font !== font) {
    fail(`the frame's font ${inner.font} is not the page's ${font}`);
  }
  if (
    !inner.policy.startsWith("default-src 'none'; style-src 'unsafe-inline'")
  ) {
    fail(`the output frame lacks its own policy: "${inner.policy}"`);
  }
  if (inner.origin !== "opaque") {
    fail(`the output frame has the page's origin: ${inner.origin}`);
  }

  // A long table scrolls in its frame, and dragging the frame's corner
  // makes it taller; a wide one scrolls sideways.
  await runNewCell(
    page,
    `from IPython.display import HTML; display(HTML(${
      JSON.stringify(LONG_TABLE)
    })); print("long-probe", "done")`,
  );
  await waitForLastOutput(page, "long-probe done", 60_000);
  const long = await lastFrame(page);
  const scrolled = await long.document.evaluate(() => {
    const root = document.scrollingElement!;
    root.scrollTop = 300;
    return { top: root.scrollTop, more: root.scrollHeight > root.clientHeight };
  });
  if (!scrolled.more || scrolled.top < 100) {
    fail(
      `a long table does not scroll in its frame: ${JSON.stringify(scrolled)}`,
    );
  }
  // Its grip must be on screen to be dragged.
  await long.wrapper.evaluate((node) =>
    node.scrollIntoView({ block: "center" })
  );
  const box = (await long.wrapper.boundingBox())!;
  await page.mouse.move(box.x + box.width - 3, box.y + box.height - 3);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 3, box.y + box.height + 147, {
    steps: 8,
  });
  await page.mouse.up();
  const resized = (await long.wrapper.boundingBox())!.height;
  if (resized < box.height + 100) {
    fail(
      `dragging the frame's corner did not resize it: ${box.height} -> ${resized}`,
    );
  }
  await runNewCell(
    page,
    `from IPython.display import HTML; display(HTML(${
      JSON.stringify(WIDE_TABLE)
    })); print("wide-probe", "done")`,
  );
  await waitForLastOutput(page, "wide-probe done", 60_000);
  const wide = await (await lastFrame(page)).document.evaluate(() => {
    const root = document.scrollingElement!;
    root.scrollLeft = 300;
    return root.scrollLeft;
  });
  if (wide < 100) fail(`a wide table does not scroll sideways: ${wide}`);
  await page.context().unroute("https://leak.example/**");
}

/** The isolation scenes in Playwright's WebKit (JUPYTERLITE_E2E_WEBKIT=1):
 * the CI scene runs Chrome only. */
export async function webkitScenes(url: string): Promise<void> {
  const { webkit } = await import("playwright");
  const browser = await webkit.launch();
  console.log(`jupyterlite e2e: webkit ${browser.version()}`);
  try {
    await checkSharedNotebookSettles(browser, url);
    console.log("jupyterlite e2e: webkit: shared notebook output settles");
    const page = await browser.newPage();
    await page.goto(`${url}/jupyter/notebooks/index.html?path=welcome.ipynb`, {
      waitUntil: "load",
    });
    await page.locator(".jp-Notebook").first().waitFor({ timeout: 60_000 });
    await waitForKernelIdle(page, 480_000);
    await page.locator(".jp-Cell").last().click();
    await checkHtmlOutputIsolation(page);
    console.log("jupyterlite e2e: webkit: HTML output isolation");
  } finally {
    await browser.close();
  }
}

if (import.meta.main) {
  await ensureBundle(
    Deno.env.get("YURT_KERNEL_ROOT") ?? join(repoRoot, "../yurtos-kernel"),
  );
  await Deno.stat(join(repoRoot, "public/jupyter/index.html")).catch(() =>
    fail("public/jupyter is missing; run jupyterlite/build.sh first")
  );
  const server = startPlaygroundServer(0);
  const browser = await launchBrowser();
  try {
    // A phone is not sent away: it reaches the home page and its links, as
    // the phone platform (the URL says so), with the Start of its shell.
    const phone = await browser.newContext({ ...devices["iPhone 13"] });
    const phonePage = await phone.newPage();
    const phoneCsp = watchCspViolations(phonePage);
    await phonePage.goto(`${server.url}/`, { waitUntil: "load" });
    await phonePage.getByTestId("choose-notebook").waitFor({ timeout: 10_000 });
    await phonePage.getByTestId("start-sandbox").waitFor({ timeout: 10_000 });
    const phonePlatform = await phonePage.evaluate(() =>
      new URL(location.href).searchParams.get("platform")
    );
    if (phonePlatform !== "phone") {
      fail(`a phone's home page is platform ${phonePlatform}, not phone`);
    }
    phoneCsp();
    // Its Notebook link leads to a page that boots no sandbox there (both
    // kernels need Python) and says why, `?start-anyway` or not.
    const coordinators: string[] = [];
    phone.on("request", (request) => {
      if (/\/(coordinator|notebook_kernel)\.bundle\.js$/.test(request.url())) {
        coordinators.push(request.url());
      }
    });
    await phonePage.goto(
      `${server.url}/jupyter/notebooks/index.html?path=welcome.ipynb&start-anyway`,
      { waitUntil: "load" },
    );
    await phonePage.waitForFunction(
      (want) =>
        document.querySelector("[data-testid=yurt-bridge-status]")
          ?.textContent === `Yurt sandbox: ${want}`,
      PHONE_REFUSAL,
      { timeout: 60_000 },
    );
    if (coordinators.length > 0) {
      fail(`a phone's Notebook page started a sandbox: ${coordinators}`);
    }
    await phone.close();

    // A page served without COOP/COEP is the one thing that cannot work: the
    // home and terminal pages both send it to the explanation.
    const plain = await browser.newContext();
    await plain.route("**/*", async (route) => {
      const response = await route.fetch();
      const headers = { ...response.headers() };
      delete headers["cross-origin-opener-policy"];
      delete headers["cross-origin-embedder-policy"];
      await route.fulfill({ response, headers });
    });
    for (const path of ["/", "/terminal.html"]) {
      const plainPage = await plain.newPage();
      await plainPage.goto(`${server.url}${path}`, { waitUntil: "load" });
      await plainPage.getByTestId("unsupported").waitFor({ timeout: 10_000 });
      await plainPage.close();
    }
    await plain.close();

    await checkTrustedClaimIgnored(
      browser,
      server.url,
      "trusted-claim.ipynb",
      "trusted-claim.ipynb",
    );
    await checkTrustedClaimIgnored(
      browser,
      server.url,
      "renamed-claim.json",
      "renamed-claim.ipynb",
    );
    await checkSharedNotebookSettles(browser, server.url);
    console.log("jupyterlite e2e: a notebook's trusted claim is ignored");

    const page = await browser.newPage();
    const started = Date.now();
    const csp = watchCspViolations(page);
    await page.goto(`${server.url}/`, { waitUntil: "domcontentloaded" });
    if (await page.evaluate(() => globalThis.crossOriginIsolated !== true)) {
      fail("browser page is not cross-origin isolated");
    }
    // "Check the bytes": the page re-hashes what it downloaded and every
    // file matches integrity.json, the 87 MB image included. The proof has a
    // section of its own, and choosing it opens it.
    await page.getByTestId("view-proof").click();
    await page.getByTestId("verify-files").click();
    await page.waitForFunction(
      () =>
        document.querySelector("[data-testid=verify-summary]")?.textContent
          ?.endsWith("files match.") === true,
      undefined,
      { timeout: 60_000 },
    );
    const summary = await page.getByTestId("verify-summary").textContent();
    // Every file integrity.json lists: six, and seven once the pins name a
    // slim browser image.
    const listed = await page.evaluate(async () =>
      Object.keys(
        (await (await fetch("./integrity.json", { cache: "no-store" }))
          .json()).files,
      ).length
    );
    if (listed < 6 || summary !== `${listed} of ${listed} files match.`) {
      fail(
        `verification did not pass: ${summary} (integrity.json lists ${listed})`,
      );
    }
    // The links are in Shell & Python.
    await page.getByTestId("view-shell").click();
    await page.getByTestId("choose-notebook").click();
    await page.waitForURL(/\/jupyter\/notebooks\/index\.html/);
    await page.locator(".jp-Notebook").first().waitFor({ timeout: 60_000 });
    // The kernel plugin boots the sandbox and connects the guest ipykernel.
    // It restores the default snapshot (ci.yml installs it for this scene),
    // so the timeout allows for a slow runner, not for an install.
    await waitForKernelIdle(page, 480_000);
    console.log(
      `jupyterlite e2e: kernel idle after ${
        Math.round((Date.now() - started) / 1000)
      } s`,
    );

    // Run the welcome notebook's two code cells with Shift+Enter.
    await page.locator(".jp-Cell").first().click();
    for (let i = 0; i < 3; i++) {
      await page.keyboard.press("Shift+Enter");
      await page.waitForTimeout(300);
    }
    await page.waitForFunction(
      () => {
        const outputs = [...document.querySelectorAll(".jp-OutputArea-output")]
          .map((node) => node.textContent ?? "");
        const prompts = [...document.querySelectorAll(".jp-InputPrompt")]
          .map((node) => node.textContent ?? "");
        return outputs.length >= 2 &&
          outputs[0].includes("3.14.") &&
          outputs[1].includes("12.") &&
          prompts.every((prompt) => !prompt.includes("*"));
      },
      undefined,
      { timeout: 180_000 },
    );
    csp();
    console.log("jupyterlite e2e: notebook executed on the guest ipykernel");

    // Guest output runs no script in the page's origin: the cell's own
    // outputs are trusted, so only the missing JavaScript renderer stops it.
    await runNewCell(
      page,
      'from IPython.display import Javascript; display(Javascript("window.__x = 1")); print("js-probe-done")',
    );
    await waitForLastOutput(page, "js-probe-done", 60_000);
    await page.waitForTimeout(1_000);
    if (await page.evaluate(() => "__x" in globalThis)) {
      fail("a guest's display(Javascript(...)) ran in the page");
    }
    console.log("jupyterlite e2e: guest JavaScript output did not run");

    await checkHtmlOutputIsolation(page);
    console.log(
      "jupyterlite e2e: HTML output stays in its sandboxed frame",
    );

    // Interrupt reaches the guest: a busy loop ends with KeyboardInterrupt
    // once the toolbar's stop button is pressed (#31).
    await runNewCell(page, "while True: pass");
    await page.waitForFunction(() =>
      [...document.querySelectorAll(".jp-InputPrompt")].some((node) =>
        node.textContent?.includes("*")
      )
    );
    await page.waitForTimeout(1_000);
    await page.locator('[data-jp-item-name="interrupt"] button').click();
    await waitForLastOutput(page, "KeyboardInterrupt", 60_000);
    console.log("jupyterlite e2e: interrupt stopped a busy loop");

    // Restart reaches the guest: a variable defined before the restart is
    // gone after it, because the ipykernel process was replaced (#31).
    await runNewCell(page, "x = 1");
    await runNewCell(page, "x");
    await waitForLastOutput(page, "1", 60_000);
    await page.locator('[data-jp-item-name="restart"] button').click();
    await page.locator(".jp-Dialog button.jp-mod-accept").click();
    await waitForKernelIdle(page, 420_000);
    await runNewCell(page, "x");
    await waitForLastOutput(page, "NameError", 120_000);
    console.log("jupyterlite e2e: restart replaced the guest kernel");

    if (Deno.env.get("JUPYTERLITE_E2E_WEBKIT") === "1") {
      await webkitScenes(server.url);
    }
  } finally {
    await browser.close();
    await server.shutdown();
  }
}
