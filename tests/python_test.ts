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

// The guest has no egress by design; pip must say so, not hang (#26). On
// kernel-wasm-v0.0.2 this call never returned; the socket layer refused
// promptly but pip's path wedged the interpreter (fixed upstream by the
// vfork-borrow work in yurtos-kernel#2774). pip's own import is ~20 s on this
// host and the refused connect a few seconds more, so the bound is generous
// but a hang still fails.
Deno.test("playground's pip fails fast without network", async () => {
  await withPythonSession(async ({ term }) => {
    const out = await typeCommand(
      term,
      "python3 -m pip download six --retries 0 --timeout 5 --no-cache-dir -d /tmp/pip-w >/tmp/pip.log 2>&1; echo pip-rc=$?; tail -2 /tmp/pip.log",
      180_000,
    );
    assertStringIncludes(out, "pip-rc=1");
    assertStringIncludes(out, "No matching distribution found for six");
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
