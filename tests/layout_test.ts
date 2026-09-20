import { assertEquals } from "@std/assert";

/** A workflow's text with the repository's own composite actions inlined
 *  where they are used (`uses: ./playground/.github/actions/<name>`), so
 *  the shape assertions below see the steps a job actually runs. */
async function workflowSource(file: string): Promise<string> {
  let text = await Deno.readTextFile(
    new URL(`../.github/workflows/${file}`, import.meta.url),
  );
  for (
    const match of text.matchAll(
      /uses: \.\/playground\/\.github\/actions\/([\w-]+)/g,
    )
  ) {
    text += "\n" + await Deno.readTextFile(
      new URL(`../.github/actions/${match[1]}/action.yml`, import.meta.url),
    );
  }
  return text;
}

Deno.test("deno.json exposes the fmt/lint/check/test tasks", () => {
  const deno = JSON.parse(
    Deno.readTextFileSync(new URL("../deno.json", import.meta.url)),
  ) as { tasks: Record<string, string> };
  assertEquals(typeof deno.tasks.fmt, "string");
  assertEquals(typeof deno.tasks.lint, "string");
  assertEquals(typeof deno.tasks.check, "string");
  assertEquals(typeof deno.tasks.test, "string");
});

Deno.test("CI fetches the pinned kernel wasm and playground image for integration tests", async () => {
  const workflow = await workflowSource("ci.yml");
  assertEquals(workflow.includes("repository: YurtOS/yurtos-kernel"), true);
  assertEquals(workflow.includes("repository: YurtOS/yurt-jupyter"), true);
  assertEquals(workflow.includes("jupyter_rev"), true);
  // Version-agnostic: dependabot bumps the pin, and these assertions pin the
  // shape of the workflow (a host python is provisioned), not the action rev.
  assertEquals(
    /actions\/setup-python@[0-9a-f]{40} # v\d+/.test(workflow),
    true,
  );
  assertEquals(
    workflow.includes(
      "HOST_PYTHON: ${{ steps.host-python.outputs.python-path }}",
    ),
    true,
  );
  assertEquals(workflow.includes("scripts/materialize-jupyter.ts"), true);
  // The Jupyter Notebook interface is built into public/jupyter before the
  // artifact-backed tests and the static build.
  assertEquals(workflow.includes("jupyterlite/build.sh"), true);
  assertEquals(/actions\/setup-node@[0-9a-f]{40} # v\d+/.test(workflow), true);
  // The two blobs are fetched from their releases, never rebuilt by CI.
  assertEquals(workflow.includes("scripts/install-pinned-artifacts.sh"), true);
  assertEquals(workflow.includes("repository: YurtOS/yurt-ports"), false);
  assertEquals(workflow.includes("scripts/build-kernel-wasm.sh"), false);
  assertEquals(workflow.includes("scripts/build-all-ports.sh"), false);
  assertEquals(workflow.includes("dtolnay/rust-toolchain"), false);
  assertEquals(workflow.includes('PLAYGROUND_REQUIRE_ARTIFACTS: "1"'), true);
  assertEquals(workflow.includes("playwright/cli.js install chromium"), true);
  // The browser artifacts are materialized by the site inputs (deno task
  // pin runs scripts/pin-artifacts.ts).
  assertEquals(workflow.includes("deno task pin"), true);
  assertEquals(workflow.includes("tests/playground_e2e.ts"), true);
  assertEquals(
    workflow.includes("deno run --allow-all tests/playground_e2e.ts"),
    true,
  );
  // The notebook interface is accepted in the same browser step.
  assertEquals(
    workflow.includes("deno run --allow-all tests/jupyterlite_e2e.ts"),
    true,
  );
  // Browser acceptance is a required step, not a repository-variable opt-in:
  // it is the only check that proves the deployed pages boot the sandbox.
  assertEquals(workflow.includes("YURT_JUPYTER_E2E"), false);
});

Deno.test("every action is pinned to a commit and no checkout keeps its credentials", async () => {
  // A moved tag runs someone else's code with the deploy secrets; a commit
  // does not move. And a checkout's token otherwise stays in .git/config for
  // every later step, including scripts a pull request can edit. The
  // repository's own composite actions (uses: ./playground/.github/actions/
  // ...) are this tree, pinned by the checkout itself; their steps are held
  // to the same rules.
  const sources: [string, string][] = [];
  for (
    const entry of Deno.readDirSync(
      new URL("../.github/workflows", import.meta.url),
    )
  ) {
    sources.push([
      entry.name,
      await Deno.readTextFile(
        new URL(`../.github/workflows/${entry.name}`, import.meta.url),
      ),
    ]);
  }
  for (
    const entry of Deno.readDirSync(
      new URL("../.github/actions", import.meta.url),
    )
  ) {
    sources.push([
      `actions/${entry.name}`,
      await Deno.readTextFile(
        new URL(`../.github/actions/${entry.name}/action.yml`, import.meta.url),
      ),
    ]);
  }
  for (const [name, workflow] of sources) {
    const uses = workflow.match(/uses: \S+/g) ?? [];
    assertEquals(uses.length > 0, true, `${name} uses no action`);
    for (const use of uses) {
      assertEquals(
        /^uses: [\w.-]+\/[\w.-]+@[0-9a-f]{40}$/.test(use) ||
          /^uses: \.\/playground\/\.github\/actions\/[\w-]+$/.test(use),
        true,
        `${name}: ${use} is not pinned to a commit`,
      );
    }
    const checkouts = uses.filter((use) => use.includes("actions/checkout@"));
    const persisted = workflow.match(/persist-credentials: false/g) ?? [];
    assertEquals(
      persisted.length,
      checkouts.length,
      `${name}: ${checkouts.length} checkouts, ${persisted.length} drop credentials`,
    );
  }
});

Deno.test("workflows authenticate every private sibling checkout", async () => {
  // The default GITHUB_TOKEN cannot read a *different* private repository, so
  // each YurtOS sibling checkout needs an explicit token. Without one the job
  // dies at "remote: Repository not found" before any step runs.
  for (const file of ["ci.yml", "deploy-pages.yml", "release-desktop.yml"]) {
    const workflow = await workflowSource(file);
    const siblings = workflow.match(/repository: YurtOS\/\S+/g) ?? [];
    assertEquals(siblings.length > 0, true, `${file} checks out no sibling`);
    // The composite takes the token as its input and hands it to its
    // checkouts; the callers pass KERNEL_CHECKOUT_TOKEN.
    const tokens = (workflow.match(
      /token: \$\{\{ (secrets\.KERNEL_CHECKOUT_TOKEN|inputs\.token) \}\}/g,
    ) ?? []).filter((t) => t.includes("inputs.token"));
    assertEquals(
      workflow.includes("token: ${{ secrets.KERNEL_CHECKOUT_TOKEN }}"),
      true,
      `${file} passes no KERNEL_CHECKOUT_TOKEN to the site inputs`,
    );
    assertEquals(
      tokens.length,
      siblings.length,
      `${file}: ${siblings.length} sibling checkouts but ${tokens.length} tokens`,
    );
  }
});

Deno.test("the site workflows fetch the pinned blobs, none builds them", async () => {
  // The kernel wasm is deterministic on a host but not across hosts, and the
  // image needs the guest toolchain plus hours of port builds, so a workflow
  // that rebuilt either could never satisfy artifacts/pins.json. All consume
  // the published releases through the same script.
  for (const file of ["ci.yml", "deploy-pages.yml", "release-desktop.yml"]) {
    const workflow = await workflowSource(file);
    assertEquals(
      workflow.includes("scripts/install-pinned-artifacts.sh"),
      true,
      `${file} does not fetch the pinned blobs`,
    );
    for (
      const build of [
        "dtolnay/rust-toolchain",
        "scripts/build-kernel-wasm.sh",
        "scripts/build-all-ports.sh",
        "repository: YurtOS/yurt-ports",
      ]
    ) {
      assertEquals(workflow.includes(build), false, `${file} has ${build}`);
    }
  }
});

Deno.test("the home page is the workspace: terminal, cell, one action to start", async () => {
  const html = await Deno.readTextFile(
    new URL("../public/index.html", import.meta.url),
  );
  assertEquals(html.includes('id="term"'), true);
  assertEquals(html.includes('data-testid="notebook"'), true);
  assertEquals(html.includes('data-testid="start-sandbox"'), true);
  // The terminal's bar shows the network state, for the offline check.
  assertEquals(html.includes('data-testid="net"'), true);
  assertEquals(html.includes('src="./boot.bundle.js"'), true);
  // The old terminal address keeps working and starts straight away.
  const terminal = await Deno.readTextFile(
    new URL("../public/terminal.html", import.meta.url),
  );
  assertEquals(terminal.includes("url=./?start=1"), true);
  // The page boots on the action, or on ?start; and the isolation gate
  // (only for the in-tab kernel) sends an unisolated page to the explanation.
  const page = await Deno.readTextFile(
    new URL("../src/page.ts", import.meta.url),
  );
  assertEquals(page.includes('searchParams.has("start")'), true);
  assertEquals(page.includes("./unsupported.html"), true);
});

Deno.test("home page offers the Notebook, JupyterLab, the source and the proof", async () => {
  const html = await Deno.readTextFile(
    new URL("../public/index.html", import.meta.url),
  );
  assertEquals(
    html.includes('href="./jupyter/notebooks/index.html?path=welcome.ipynb"'),
    true,
  );
  assertEquals(html.includes('href="./jupyter/lab/index.html"'), true);
  // The source is public; the page says where.
  assertEquals(
    html.includes('href="https://github.com/YurtOS/yurt-playground"'),
    true,
  );
  // The "is this really in your browser" disclosure and its live check.
  assertEquals(html.includes('data-testid="proof"'), true);
  assertEquals(html.includes('data-testid="proof-toggle"'), true);
  assertEquals(html.includes('data-testid="snapshots"'), true);
  assertEquals(html.includes('data-testid="snapshot-demo"'), true);
  assertEquals(html.includes('href="./snapshot.html"'), true);
  assertEquals(html.includes('data-testid="verify-files"'), true);
  assertEquals(html.includes('src="./verify.js"'), true);
  assertEquals(
    (await Deno.readTextFile(new URL("../public/verify.js", import.meta.url)))
      .includes("integrity.json"),
    true,
  );
  // Tablets get a note; phones and a boot that dies get the explanation.
  assertEquals(html.includes('data-testid="mobile-note"'), true);
  assertEquals(html.includes('data-testid="boot-failed"'), true);
  for (const why of ["phone", "tablet", "reloaded", "error"]) {
    assertEquals(html.includes(`data-why="${why}"`), true, why);
  }
  const unsupported = await Deno.readTextFile(
    new URL("../public/unsupported.html", import.meta.url),
  );
  assertEquals(unsupported.includes('data-testid="unsupported"'), true);
  assertEquals(unsupported.includes("Cross-Origin-Embedder-Policy"), true);
});

Deno.test("deployment workflow publishes an isolated static site", async () => {
  const workflow = await workflowSource("deploy-pages.yml");
  assertEquals(
    /actions\/setup-python@[0-9a-f]{40} # v\d+/.test(workflow),
    true,
  );
  for (
    const value of [
      'python-version: "3.14.0"',
      "HOST_PYTHON: ${{ steps.host-python.outputs.python-path }}",
      "scripts/install-pinned-artifacts.sh",
      "jupyterlite/build.sh",
      "dist",
      "_headers",
      "CLOUDFLARE_API_TOKEN",
      "CLOUDFLARE_ACCOUNT_ID",
      "CLOUDFLARE_PROJECT_NAME",
      "repository: YurtOS/yurt-jupyter",
      "scripts/materialize-jupyter.ts",
    ]
  ) {
    assertEquals(workflow.includes(value), true);
  }
});

Deno.test("every workflow restricts its token to reading the repository", async () => {
  // Nothing here pushes or writes to the repository, and a public repository
  // runs these on pull requests from strangers. The cross-repo and Cloudflare
  // credentials are named secrets, not the workflow token.
  for (
    const entry of Deno.readDirSync(
      new URL("../.github/workflows", import.meta.url),
    )
  ) {
    const workflow = await Deno.readTextFile(
      new URL(`../.github/workflows/${entry.name}`, import.meta.url),
    );
    assertEquals(
      workflow.includes("\npermissions:\n  contents: read\n"),
      true,
      `${entry.name} does not restrict the workflow token to contents: read`,
    );
  }
});
