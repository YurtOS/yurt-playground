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
  assertEquals(workflow.includes("ports_rev"), true);
  assertEquals(workflow.includes("scripts/build-kernel-wasm.sh"), true);
  assertEquals(workflow.includes("wasm32-wasip1-threads"), true);
  assertEquals(
    workflow.includes(
      "scripts/build-all-ports.sh --only zlib openssl sqlite busybox cpython --build-only",
    ),
    true,
  );
  assertEquals(workflow.includes("YURT_PORTS_ROOT: ../yurt-ports"), true);
});
