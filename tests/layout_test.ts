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
  // YURT_JUPYTER_STAGE is deliberately absent now. It fed the image BUILD,
  // staging the locked payload into the rootfs; the workflow fetches a
  // published image that already carries it. Asserting its absence keeps the
  // two from silently drifting back apart -- a stage variable reappearing here
  // would mean something started rebuilding the image again.
  assertEquals(
    workflow.includes("YURT_JUPYTER_STAGE"),
    false,
    "the fetched image already carries the locked payload; nothing should stage it",
  );
  assertEquals(workflow.includes("ports_rev"), true);
  // The kernel wasm is FETCHED, not rebuilt. Its build is deterministic on a
  // given host but not across hosts: the pin recorded a maintainer's bytes and
  // ubuntu-latest reproducibly built different ones, so every run failed the pin
  // check. Assert the fetch and the sha check rather than the build it replaced.
  assertEquals(workflow.includes("scripts/install-kernel-wasm.sh"), true);
  assertEquals(
    workflow.includes("jq -r .kernelWasm.sha256 artifacts/pins.json"),
    true,
  );
  assertEquals(
    workflow.includes("scripts/build-kernel-wasm.sh"),
    false,
    "playground CI must not rebuild the kernel; it consumes the published wasm",
  );
  const kernelFetch = workflow.slice(
    workflow.indexOf("- name: Fetch pinned kernel wasm"),
    workflow.indexOf("- name: Save the pinned kernel wasm"),
  );
  assertEquals(
    kernelFetch.includes("GH_TOKEN: ${{ secrets.KERNEL_CHECKOUT_TOKEN }}"),
    true,
    "the kernel wasm fetch must use the PAT that can read the private release repo",
  );
  assertEquals(
    /GH_TOKEN:\s*\$\{\{\s*github\.token/.test(kernelFetch),
    false,
    "github.token cannot read the private release repo",
  );
  // The image is FETCHED, not rebuilt. Building it ran the pinned kernel's
  // `make -C abi lib`, which needs a wasi-sdk this workflow never installed, so
  // every cache miss failed. Pin the fetch and the sha check rather than the
  // build command this replaced.
  assertEquals(
    workflow.includes("scripts/install-playground-image.sh"),
    true,
  );
  assertEquals(
    workflow.includes("jq -r .image.sha256 artifacts/pins.json"),
    true,
  );
  // The image fetch needs the cross-repo PAT: yurt-packages is private and the
  // default github.token 404s there. Assert the fetch step does not fall back
  // to github.token -- CI failed exactly that way once.
  const fetchStep = workflow.slice(
    workflow.indexOf("- name: Fetch pinned playground image"),
    workflow.indexOf("- name: Save the pinned playground image"),
  );
  assertEquals(
    fetchStep.includes("GH_TOKEN: ${{ secrets.KERNEL_CHECKOUT_TOKEN }}"),
    true,
    "the image fetch must use the PAT that can read the private release repo",
  );
  // Match the assignment, not the word: the step's comment explains why
  // github.token is wrong, and prose must not fail the test.
  assertEquals(
    /GH_TOKEN:\s*\$\{\{\s*github\.token/.test(fetchStep),
    false,
    "github.token cannot read the private release repo",
  );
  assertEquals(
    workflow.includes("scripts/build-all-ports.sh"),
    false,
    "playground CI must not rebuild ports; it consumes the published image",
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

Deno.test("only the publishing workflow builds Rust", async () => {
  // There used to be two Rust builds here and a test that they agreed on a
  // toolchain. Both were consumers rebuilding an artifact they could not
  // reproduce. Now exactly one workflow builds the kernel wasm and publishes
  // it; a toolchain reappearing in a consumer means someone started rebuilding
  // it again, which is the failure this replaced.
  for (const file of ["ci.yml", "deploy-pages.yml"]) {
    const workflow = await Deno.readTextFile(
      new URL(`../.github/workflows/${file}`, import.meta.url),
    );
    assertEquals(
      /uses:\s*dtolnay\/rust-toolchain@/.test(workflow),
      false,
      `${file} installs a Rust toolchain; it consumes published artifacts`,
    );
  }
  const publisher = await Deno.readTextFile(
    new URL("../.github/workflows/publish-kernel-wasm.yml", import.meta.url),
  );
  // The tag of dtolnay/rust-toolchain *is* the toolchain version, and it has to
  // match yurtos-kernel/rust-toolchain.toml. Nothing here can check it against
  // the kernel, but an unpinned one we can catch.
  assertEquals(
    /uses:\s*dtolnay\/rust-toolchain@\d+\.\d+\.\d+/.test(publisher),
    true,
    "the publisher must pin an exact Rust toolchain",
  );
  assertEquals(publisher.includes("scripts/build-kernel-wasm.sh"), true);
  assertEquals(publisher.includes("wasm32-wasip1-threads"), true);
});

Deno.test("page exposes the real notebook execution surface", async () => {
  const html = await Deno.readTextFile(
    new URL("../public/index.html", import.meta.url),
  );
  assertEquals(html.includes('data-testid="notebook"'), true);
  assertEquals(html.includes('id="term"'), true);
});

Deno.test("classic coordinator resolves the bundled Worker bootstrap", async () => {
  const source = await Deno.readTextFile(
    new URL("../scripts/serve.ts", import.meta.url),
  );
  assertEquals(source.includes('"./worker_bootstrap.ts"'), true);
  assertEquals(source.includes('"./worker_bootstrap.js"'), true);
});

Deno.test("deployment workflow publishes an isolated static site", async () => {
  const workflow = await Deno.readTextFile(
    new URL("../.github/workflows/deploy-pages.yml", import.meta.url),
  );
  assertEquals(/actions\/setup-python@v\d+/.test(workflow), true);
  for (
    const value of [
      'python-version: "3.14.0"',
      "HOST_PYTHON: ${{ steps.host-python.outputs.python-path }}",
      "dist",
      "_headers",
      "CLOUDFLARE_API_TOKEN",
      "CLOUDFLARE_ACCOUNT_ID",
      "CLOUDFLARE_PROJECT_NAME",
      "repository: YurtOS/yurt-jupyter",
      "scripts/materialize-jupyter.ts",
      // The deploy ships the same three published artifacts CI tested, fetched
      // by the same scripts. Building them here was what turned it red: the
      // image build needs a wasi-sdk this workflow never installed.
      "scripts/install-kernel-wasm.sh",
      "scripts/install-playground-image.sh",
      "scripts/install-jupyter-payload.sh",
    ]
  ) {
    assertEquals(workflow.includes(value), true, `deploy lacks ${value}`);
  }
  for (
    const value of [
      "scripts/build-kernel-wasm.sh",
      "scripts/build-all-ports.sh",
      // Fed the image BUILD, staging the locked payload into the rootfs. The
      // fetched image already carries it; a stage variable reappearing here
      // would mean something started rebuilding the image again.
      "YURT_JUPYTER_STAGE",
    ]
  ) {
    assertEquals(
      workflow.includes(value),
      false,
      `deploy still rebuilds an artifact it should fetch: ${value}`,
    );
  }
});
