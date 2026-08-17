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
