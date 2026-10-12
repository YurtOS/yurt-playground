import { assertEquals } from "@std/assert";
Deno.test("aggregate CI fails every required leg and unknown qualification verdict", async () => {
  const workflow = await Deno.readTextFile(
    new URL("../.github/workflows/ci.yml", import.meta.url),
  );
  const integration = workflow.slice(workflow.indexOf("  integration:"));
  const script = integration.slice(
    integration.indexOf("        run: |") + "        run: |".length,
  ).split("\n").map((line) => line.replace(/^ {10}/, "")).join("\n");
  const defaults = {
    CHECKS: "success",
    TOKEN_PRESENT: "true",
    TESTS: "success",
    ACCEPTANCE: "success",
    DATASETTE_QUALIFIED: "false",
    DATASETTE: "skipped",
  };
  for (
    const [env, expected] of [
      [{}, 0],
      [{ TESTS: "failure" }, 1],
      [{ ACCEPTANCE: "failure" }, 1],
      [{ DATASETTE_QUALIFIED: "true", DATASETTE: "success" }, 0],
      [{ DATASETTE_QUALIFIED: "true", DATASETTE: "skipped" }, 1],
      [{ DATASETTE_QUALIFIED: "" }, 1],
    ] as const
  ) {
    const result = await new Deno.Command("bash", {
      args: ["-c", script],
      env: { ...defaults, ...env },
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(result.code === 0, expected === 0, JSON.stringify(env));
  }
});
