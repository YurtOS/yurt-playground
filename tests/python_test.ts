import { assertStringIncludes } from "@std/assert";
import {
  type AshSession,
  bootAshSession,
  typeCommand,
  waitFor,
} from "./ash_harness.ts";

async function withPythonSession(
  run: (session: AshSession) => Promise<void>,
): Promise<void> {
  const session = await bootAshSession({ requireArtifacts: true });
  if (session === undefined) {
    throw new Error("required Python session unexpectedly skipped");
  }
  try {
    await run(session);
  } finally {
    session.stop();
  }
}

Deno.test("playground runs Python 3 one-shot commands with PYTHONHOME", async () => {
  await withPythonSession(async ({ term }) => {
    assertStringIncludes(
      await typeCommand(term, "python3 -c 'print(2**20)'"),
      "1048576",
    );
    assertStringIncludes(
      await typeCommand(
        term,
        "python3 -c 'import os; print(os.environ[\"PYTHONHOME\"])'",
      ),
      "/usr/local",
    );
    assertStringIncludes(
      await typeCommand(term, "python -c 'print(2**20)'"),
      "1048576",
    );
  });
});

Deno.test("playground runs an interactive Python 3 REPL", async () => {
  await withPythonSession(async ({ term }) => {
    term.type("python3\n");
    await waitFor(() => term.output().includes(">>> "), "python prompt");
    term.type("print(6 * 7)\n");
    await waitFor(() => term.output().includes("42"), "python result");
  });
});
