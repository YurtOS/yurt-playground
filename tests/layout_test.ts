import { assertEquals } from "@std/assert";

Deno.test("deno.json exposes the fmt/lint/check/test tasks", () => {
  const deno = JSON.parse(
    Deno.readTextFileSync(new URL("../deno.json", import.meta.url)),
  ) as { tasks: Record<string, string> };
  assertEquals(typeof deno.tasks.fmt, "string");
  assertEquals(typeof deno.tasks.lint, "string");
  assertEquals(typeof deno.tasks.check, "string");
  assertEquals(typeof deno.tasks.test, "string");
});

Deno.test("CI materializes the pinned playground image for integration tests", async () => {
  const workflow = await Deno.readTextFile(
    new URL("../.github/workflows/ci.yml", import.meta.url),
  );
  assertEquals(workflow.includes("repository: YurtOS/yurt-ports"), true);
  assertEquals(workflow.includes("repository: YurtOS/yurt-jupyter"), true);
  assertEquals(workflow.includes("jupyter_rev"), true);
  // Version-agnostic: dependabot bumps the major, and these assertions pin the
  // shape of the workflow (a host python is provisioned), not the action tag.
  assertEquals(/actions\/setup-python@v\d+/.test(workflow), true);
  assertEquals(
    workflow.includes(
      "HOST_PYTHON: ${{ steps.host-python.outputs.python-path }}",
    ),
    true,
  );
  assertEquals(workflow.includes("scripts/materialize-jupyter.ts"), true);
  assertEquals(workflow.includes("YURT_JUPYTER_STAGE"), true);
  assertEquals(workflow.includes("ports_rev"), true);
  assertEquals(workflow.includes("scripts/build-kernel-wasm.sh"), true);
  assertEquals(workflow.includes("wasm32-wasip1-threads"), true);
  assertEquals(
    workflow.includes(
      "scripts/build-all-ports.sh --only zlib openssl sqlite libcxx libzmq busybox cpython numpy pyzmq --build-only",
    ),
    true,
  );
  assertEquals(workflow.includes("YURT_PORTS_ROOT: ../yurt-ports"), true);
  assertEquals(workflow.includes('PLAYGROUND_REQUIRE_ARTIFACTS: "1"'), true);
  assertEquals(workflow.includes("playwright/cli.js install chromium"), true);
  assertEquals(workflow.includes("scripts/pin-artifacts.ts"), true);
  assertEquals(workflow.includes("tests/playground_e2e.ts"), true);
  assertEquals(
    workflow.includes("run: deno run --allow-all tests/playground_e2e.ts"),
    true,
  );
  assertEquals(
    workflow.includes("if: vars.YURT_JUPYTER_E2E == 'true'"),
    true,
  );
});

Deno.test("workflows authenticate every private sibling checkout", async () => {
  // The default GITHUB_TOKEN cannot read a *different* private repository, so
  // each YurtOS sibling checkout needs an explicit token. Without one the job
  // dies at "remote: Repository not found" before any step runs.
  for (const file of ["ci.yml", "deploy-pages.yml"]) {
    const workflow = await Deno.readTextFile(
      new URL(`../.github/workflows/${file}`, import.meta.url),
    );
    const siblings = workflow.match(/repository: YurtOS\/\S+/g) ?? [];
    assertEquals(siblings.length > 0, true, `${file} checks out no sibling`);
    const tokens =
      workflow.match(/token: \$\{\{ secrets\.KERNEL_CHECKOUT_TOKEN \}\}/g) ??
        [];
    assertEquals(
      tokens.length,
      siblings.length,
      `${file}: ${siblings.length} sibling checkouts but ${tokens.length} tokens`,
    );
  }
});

Deno.test("both workflows select the same Rust toolchain", async () => {
  // The tag of dtolnay/rust-toolchain *is* the toolchain version, and it has
  // to match yurtos-kernel/rust-toolchain.toml. Nothing in this repo can check
  // it against the kernel, but the two workflows drifting apart is a bug we
  // can catch: they build the same artifacts.
  const versions = new Set<string>();
  for (const file of ["ci.yml", "deploy-pages.yml"]) {
    const workflow = await Deno.readTextFile(
      new URL(`../.github/workflows/${file}`, import.meta.url),
    );
    const match = workflow.match(/dtolnay\/rust-toolchain@(\S+)/);
    assertEquals(match !== null, true, `${file} pins no Rust toolchain`);
    versions.add(match![1]);
  }
  assertEquals(versions.size, 1, `toolchains differ: ${[...versions]}`);
});

Deno.test("page exposes the real notebook execution surface", async () => {
  const html = await Deno.readTextFile(
    new URL("../public/index.html", import.meta.url),
  );
  assertEquals(html.includes('data-testid="notebook"'), true);
  assertEquals(html.includes('id="term"'), true);
});

Deno.test("deployment workflow publishes an isolated static site", async () => {
  const workflow = await Deno.readTextFile(
    new URL("../.github/workflows/deploy-pages.yml", import.meta.url),
  );
  assertEquals(/actions\/setup-python@v\d+/.test(workflow), true);
  for (
    const value of [
      'python-version: "3.14"',
      "HOST_PYTHON: ${{ steps.host-python.outputs.python-path }}",
      "scripts/build-all-ports.sh --only zlib openssl sqlite libcxx libzmq busybox cpython numpy pyzmq --build-only",
      "dist",
      "_headers",
      "CLOUDFLARE_API_TOKEN",
      "CLOUDFLARE_ACCOUNT_ID",
      "CLOUDFLARE_PROJECT_NAME",
      "repository: YurtOS/yurt-jupyter",
      "YURT_JUPYTER_STAGE",
      "scripts/materialize-jupyter.ts",
    ]
  ) {
    assertEquals(workflow.includes(value), true);
  }
});
