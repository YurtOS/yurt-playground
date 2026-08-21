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
  assertEquals(workflow.includes("actions/setup-python@v6"), true);
  assertEquals(workflow.includes("scripts/materialize-jupyter.ts"), true);
  assertEquals(workflow.includes("YURT_JUPYTER_STAGE"), true);
  assertEquals(workflow.includes("ports_rev"), true);
  assertEquals(workflow.includes("scripts/build-kernel-wasm.sh"), true);
  assertEquals(workflow.includes("wasm32-wasip1-threads"), true);
  assertEquals(
    workflow.includes(
      "scripts/build-all-ports.sh --only zlib openssl sqlite libcxx libzmq busybox cpython --build-only",
    ),
    true,
  );
  assertEquals(workflow.includes("YURT_PORTS_ROOT: ../yurt-ports"), true);
  assertEquals(workflow.includes('PLAYGROUND_REQUIRE_ARTIFACTS: "1"'), true);
  assertEquals(workflow.includes("playwright/cli.js install chromium"), true);
  assertEquals(workflow.includes("tests/playground_e2e.ts"), true);
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
  for (
    const value of [
      "scripts/build-all-ports.sh --only zlib openssl sqlite libcxx libzmq busybox cpython --build-only",
      "dist",
      "_headers",
      "CLOUDFLARE_API_TOKEN",
      "CLOUDFLARE_ACCOUNT_ID",
      "CLOUDFLARE_PROJECT_NAME",
    ]
  ) {
    assertEquals(workflow.includes(value), true);
  }
});
