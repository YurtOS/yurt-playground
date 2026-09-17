import { assertEquals } from "@std/assert";
import {
  buildKernelLaunchCommand,
  buildKernelOwnProcessLine,
  buildKernelStartLine,
  JUPYTER_CONNECTION_FILE,
  JUPYTER_LOG_FILE,
  JUPYTER_PID_FILE,
} from "../src/jupyter.ts";
import { stripAnsi } from "../src/notebook.ts";

Deno.test("Jupyter launch uses Python 3 and a guest connection file", () => {
  assertEquals(
    buildKernelLaunchCommand(),
    `python3 -m ipykernel_launcher --ip=127.0.0.1 --transport=tcp ` +
      `--Session.key=yurt --f=${JUPYTER_CONNECTION_FILE}`,
  );
});

Deno.test("the kernel start line backgrounds the launch and records its pid", () => {
  // Not in a subshell yet: on the native runtime a child is lost when its
  // parent exits (yurtos-kernel#2816), so the kernel stays a job of the
  // interactive shell for now (yurt-playground#82).
  const line = buildKernelStartLine();
  assertEquals(
    line,
    `${buildKernelLaunchCommand()} >${JUPYTER_LOG_FILE} 2>&1 & echo $! > ${JUPYTER_PID_FILE}`,
  );
});

Deno.test("stripAnsi removes ipykernel's colour codes from a traceback line", () => {
  assertEquals(
    stripAnsi("\x1b[31m---\x1b[39m ZeroDivisionError\x1b[0m: division by zero"),
    "--- ZeroDivisionError: division by zero",
  );
  assertEquals(stripAnsi("plain"), "plain");
});

Deno.test("as its own process the kernel records its pid and execs in place", () => {
  // Typed at the prompt, ipykernel was job [1] of the user's own shell and
  // `kill %1` killed it (yurt-playground#82). Spawned as the page's own
  // `sh -c`, the shell notes its pid (the kernel's, after exec) for the
  // stop command and becomes the kernel; no job table is involved.
  assertEquals(
    buildKernelOwnProcessLine(),
    `echo $$ > ${JUPYTER_PID_FILE}; exec ${buildKernelLaunchCommand()} >${JUPYTER_LOG_FILE} 2>&1`,
  );
});
