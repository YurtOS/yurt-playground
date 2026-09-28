import { assertEquals, assertStringIncludes } from "@std/assert";
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

Deno.test("browser fixed ports retain loopback binding while native ports retain native binding", async () => {
  const {
    BROWSER_KERNEL_PORTS,
    buildKernelLaunchCommand,
    buildKernelOwnProcessLine,
  } = await import("../src/jupyter.ts");
  const browser = buildKernelLaunchCommand(
    undefined,
    BROWSER_KERNEL_PORTS,
    "127.0.0.1",
  );
  for (
    const flag of [
      "--ip=127.0.0.1",
      "--shell=49161",
      "--iopub=49162",
      "--stdin=49163",
      "--control=49164",
      "--hb=49165",
    ]
  ) assertStringIncludes(browser, flag);
  assertStringIncludes(
    buildKernelOwnProcessLine(
      BROWSER_KERNEL_PORTS,
      undefined,
      undefined,
      undefined,
      "127.0.0.1",
    ),
    "--ip=127.0.0.1",
  );
  assertStringIncludes(
    buildKernelLaunchCommand(undefined, [8002, 8003, 8004, 8005, 8006]),
    "--ip=0.0.0.0",
  );
});
