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
      await typeCommand(term, "python3 -c 'print(2**20)'", 60_000),
      "1048576",
    );
    assertStringIncludes(
      await typeCommand(
        term,
        "python3 -c 'import os; print(os.environ[\"PYTHONHOME\"])'",
        60_000,
      ),
      "/usr/local",
    );
    assertStringIncludes(
      await typeCommand(term, "python -c 'print(2**20)'", 60_000),
      "1048576",
    );
    assertStringIncludes(
      await typeCommand(
        term,
        "python -c 'import os; print(len(os.urandom(32)))'",
        60_000,
      ),
      "32",
    );
  });
});

Deno.test("playground runs an interactive Python 3 REPL", async () => {
  await withPythonSession(async ({ term }) => {
    const before = term.output().length;
    let replStarted = false;
    try {
      term.type("python3\n");
      // The first CPython launch in a fresh sandbox pays the module's cold
      // compile: ~25 s on an M-series laptop, ~90 s on ubuntu-latest
      // (measured 2026-09-14, CI run 34835655313 timed out at 60 s).
      await waitFor(
        () => term.output().slice(before).includes(">>> "),
        "python prompt",
        180_000,
      );
      replStarted = true;
      term.type("1+2\n");
      await waitFor(
        () => /3\r?\n/.test(term.output().slice(before)),
        "python result",
        60_000,
      );
    } finally {
      if (replStarted) {
        const exitBefore = term.output().length;
        term.type("exit()\n");
        await waitFor(
          () => term.output().slice(exitBefore).includes("$ "),
          "ash prompt after Python exit",
          60_000,
        );
      }
    }
  });
});
