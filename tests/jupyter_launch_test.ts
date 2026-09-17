import { assertEquals } from "@std/assert";
import {
  buildKernelLaunchCommand,
  buildKernelStartLine,
  JUPYTER_CONNECTION_FILE,
} from "../src/jupyter.ts";
import { stripAnsi } from "../src/notebook.ts";

Deno.test("Jupyter launch uses Python 3 and a guest connection file", () => {
  assertEquals(
    buildKernelLaunchCommand(),
    `python3 -m ipykernel_launcher --ip=127.0.0.1 --transport=tcp ` +
      `--Session.key=yurt --f=${JUPYTER_CONNECTION_FILE}`,
  );
});

Deno.test("the kernel is started outside the interactive shell's job table", () => {
  // `cmd &` typed at the prompt makes ipykernel job [1] of the user's own
  // shell, so the ordinary `sleep 30 & … kill %1` kills Jupyter instead of
  // the user's job (yurt-playground#82). A subshell keeps it off the list.
  const line = buildKernelStartLine();
  assertEquals(line.startsWith("("), true, line);
  assertEquals(line.includes(`${buildKernelLaunchCommand()} >`), true, line);
  assertEquals(line.trimEnd().endsWith(")"), true, line);
});

Deno.test("stripAnsi removes ipykernel's colour codes from a traceback line", () => {
  assertEquals(
    stripAnsi("\x1b[31m---\x1b[39m ZeroDivisionError\x1b[0m: division by zero"),
    "--- ZeroDivisionError: division by zero",
  );
  assertEquals(stripAnsi("plain"), "plain");
});
