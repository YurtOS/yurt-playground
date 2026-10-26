import { assert, assertEquals } from "@std/assert";
import {
  mountNotebook,
  PYTHON_INSTALL,
  PYTHON_MISSING_TEXT,
} from "../src/notebook.ts";

/** Just enough of the DOM for `mountNotebook`: elements with the
 * properties it sets, found by `data-testid`. */
type FakeElement = {
  tag: string;
  id: string;
  className: string;
  type: string;
  value: string;
  textContent: string;
  hidden: boolean;
  disabled: boolean;
  dataset: Record<string, string>;
  style: Record<string, string>;
  children: FakeElement[];
  onclick: (() => void) | null;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  append(...children: FakeElement[]): void;
  replaceChildren(...children: FakeElement[]): void;
  setAttribute(name: string, value: string): void;
};

function fakeElement(tag: string): FakeElement {
  const element: FakeElement = {
    tag,
    id: "",
    className: "",
    type: "",
    value: "",
    textContent: "",
    hidden: false,
    disabled: false,
    dataset: {},
    style: {},
    children: [],
    onclick: null,
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
    append(...children) {
      element.children.push(...children);
    },
    replaceChildren(...children) {
      element.children = children;
    },
    setAttribute() {},
  };
  return element;
}

function byTestId(root: FakeElement, testid: string): FakeElement {
  const walk = (node: FakeElement): FakeElement | undefined =>
    node.dataset.testid === testid
      ? node
      : node.children.map(walk).find((n) => n !== undefined);
  const found = walk(root);
  if (found === undefined) throw new Error(`no [data-testid=${testid}]`);
  return found;
}

function mount() {
  const saved = globalThis.document;
  (globalThis as { document?: unknown }).document = {
    createElement: fakeElement,
  };
  try {
    const root = fakeElement("section");
    const view = mountNotebook(
      root as unknown as HTMLElement,
      () => {},
      () => {},
    );
    return { root, view };
  } finally {
    (globalThis as { document?: unknown }).document = saved;
  }
}

Deno.test("an image without python3: the cell says so, and Install waits for the packages", () => {
  const { root, view } = mount();
  const missing = byTestId(root, "python-missing");
  assertEquals(missing.hidden, true, "hidden until an image without python3");
  view.pythonMissing(PYTHON_INSTALL);
  assertEquals(
    byTestId(root, "notebook-status").textContent,
    PYTHON_MISSING_TEXT,
  );
  assertEquals(missing.hidden, false);
  const install = byTestId(root, "python-install");
  assertEquals(install.textContent, "Install");
  // The one switch the install change flips; until then a disabled button
  // with its reason.
  assertEquals(PYTHON_INSTALL.available, false);
  assertEquals(install.disabled, true);
  assertEquals(
    byTestId(root, "python-install-reason").textContent,
    "Python packages are not published yet",
  );
  assertEquals(byTestId(root, "notebook-execute").disabled, true);
  assertEquals(byTestId(root, "notebook-input").disabled, true);
});

Deno.test("once Python is installable, Install is enabled and runs the install", () => {
  const { root, view } = mount();
  let installs = 0;
  view.pythonMissing({ available: true, reason: "" }, () => installs++);
  const install = byTestId(root, "python-install");
  assertEquals(install.disabled, false);
  install.onclick?.();
  assertEquals(installs, 1);
  assertEquals(byTestId(root, "python-install-reason").textContent, "");
  // Available but nothing to run it with stays disabled.
  view.pythonMissing({ available: true, reason: "" });
  assertEquals(install.disabled, true);
});

const pageSource = () =>
  Deno.readTextFileSync(new URL("../src/page.ts", import.meta.url));

Deno.test("the page ends the boot on python-missing: no 'tab reloaded' memory, the cell's own state", () => {
  const page = pageSource();
  const handler = page.match(
    /if \(msg\.type === "python-missing"\) \{([^]*?)\n {4}\}/,
  );
  assert(handler !== null, "page.ts handles python-missing");
  // Left set, the next load reads a cut-off boot ("the browser reloaded
  // this tab ... memory") for a boot that finished.
  assert(/rememberBooting\(undefined\)/.test(handler[1]), handler[1]);
  assert(/notebook\.pythonMissing\(PYTHON_INSTALL\)/.test(handler[1]));
  assert(/status\.progress\("running", \{ settled: true \}\)/.test(handler[1]));
});

Deno.test("a later error does not turn the python-missing cell into 'Jupyter did not start'", () => {
  const page = pageSource();
  assert(
    /if \(msg\.type === "python-missing"\) \{[^}]*pythonMissing = true;/.test(
      page,
    ),
  );
  assert(
    /if \(!notebookReady && !shellOnly && !pythonMissing\) \{\s*notebook\.unavailable\("Jupyter did not start"\);/
      .test(page),
  );
  // The boot's settled states release an action's error from #status.
  for (const settled of ["notebook-ready", "shell-ready", "python-missing"]) {
    assert(
      new RegExp(
        `msg\\.type === "${settled}"\\) \\{[^}]*status\\.progress\\("running", \\{ settled: true \\}\\)`,
      ).test(page),
      settled,
    );
  }
  assertEquals(/dataset\.python/.test(page), false, "no unused page state");
});

Deno.test("a Jupyter failure after the shell is up leaves the shell and says the cell has no kernel", () => {
  const page = pageSource();
  assert(
    /if \(!terminalEmpty\) \{[^}]*status\.failure\(`failed: \$\{message\}`\);[^]*?notebook\.unavailable\("Jupyter did not start"\)/
      .test(page),
  );
  // Download home's failure holds the status line against the ticker.
  assert(
    /status\.notice\(\s*`download home failed: [^]*?\{ error: true \}/.test(
      page,
    ),
  );
});

Deno.test("the home page's copy does not promise Python 3.14 and NumPy", () => {
  const html = Deno.readTextFileSync(
    new URL("../public/index.html", import.meta.url),
  );
  const lead = html.match(/<p class="lead" id="lead">([^]*?)<\/p>/);
  assert(lead !== null);
  assertEquals(/3\.14|NumPy/.test(lead[1]), false, lead[1]);
  // The start pane: the slim image is ~14 MB, the full one ~90.
  assertEquals(/Loads about 90 MB/.test(html), false);
  assertEquals(/Python 3\.14, NumPy/.test(pageSource()), false);
});
