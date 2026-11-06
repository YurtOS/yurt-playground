import {
  DEMO_COLOR,
  DEMO_COLOR_PATH,
  DEMO_PDF_MADE,
  DEMO_PDF_PATH,
  DEMO_TEXT_PATH,
  MAKE_DEMO_PDF,
  makePdfCommand,
  pdfMade,
  ToolFailed,
  type Tools,
} from "./agent.ts";
import {
  PYTHON_MISSING_EXIT,
  PYTHON_PROBE_COMMAND,
} from "./coordinator_start.ts";
import { checkPath, type Yurt } from "./agent_api.ts";
import { DEFAULT_MAX_OUTPUT_BYTES, quoted } from "./executions.ts";

function cancelled(): Error {
  const error = new Error("cancelled");
  error.name = "AbortError";
  return error;
}

async function abortable<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) throw cancelled();
  let rejectAbort!: (reason: Error) => void;
  const aborted = new Promise<never>((_, reject) => rejectAbort = reject);
  const onAbort = () => rejectAbort(cancelled());
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

async function runCommand(
  yurt: Yurt,
  command: string,
  timeoutMs: number,
  maxOutputBytes: number,
  signal: AbortSignal,
) {
  if (signal.aborted) throw cancelled();
  const spawning = yurt.spawn(command, { timeoutMs, maxOutputBytes });
  let execution;
  try {
    execution = await abortable(spawning, signal);
  } catch (error) {
    if (signal.aborted) {
      void spawning.then((late) => late.kill()).catch(() => {});
    }
    throw error;
  }

  const kill = () => void execution.kill().catch(() => {});
  signal.addEventListener("abort", kill, { once: true });
  if (signal.aborted) {
    signal.removeEventListener("abort", kill);
    kill();
    throw cancelled();
  }
  try {
    const result = await abortable(execution.wait(), signal);
    if (signal.aborted) throw cancelled();
    return result;
  } finally {
    signal.removeEventListener("abort", kill);
  }
}

/** A command's time limit. Long enough for `sudo pkg` to wait out the Python
 * set the slim image installs at boot: about a minute, holding pkg's lock. */
const EXEC_TIMEOUT_MS = 120_000;
/** The text of a PDF other than the demo's, on its way to mkpdf. */
const PDF_TEXT_PATH = "/tmp/agent-pdf.txt";

export function createAgentTools(yurt: Yurt): Tools {
  const makePdf = async (
    command: string,
    wrote: string,
    signal: AbortSignal,
  ) => {
    const made = await runCommand(
      yurt,
      command,
      EXEC_TIMEOUT_MS,
      DEFAULT_MAX_OUTPUT_BYTES,
      signal,
    );
    // Only too much text is the model's to fix (mkpdf's exit 3).
    if ("code" in made && made.code === 3) {
      throw new Error(`${wrote}, but no PDF: ${made.stderr}`);
    }
    if (!("code" in made) || made.code !== 0) {
      throw new ToolFailed(
        `The text is saved, but the PDF could not be made: ${
          made.stderr || "the command timed out"
        }`,
      );
    }
  };
  return {
    async exec(cmd, signal) {
      const result = await runCommand(
        yurt,
        cmd,
        EXEC_TIMEOUT_MS,
        DEFAULT_MAX_OUTPUT_BYTES,
        signal,
      );
      return {
        code: "code" in result ? result.code : null,
        stdout: result.stdout,
        // Without this the model sees only "exit none" and cannot tell why.
        stderr: result.timedOut
          ? `${result.stderr}timed out after ${EXEC_TIMEOUT_MS / 1000} s\n`
          : result.stderr,
      };
    },
    async writeFile(path, text, signal) {
      // As the file system reads it: /home/user/./demo.txt is the same file.
      const file = new URL(`file://${checkPath(path)}`).pathname;
      // Models do try, and text there would destroy the PDF.
      if (file === DEMO_PDF_PATH) {
        throw new Error(
          `${DEMO_PDF_PATH} is made from ${DEMO_TEXT_PATH}; write that instead`,
        );
      }
      const wrote = `wrote ${text.length} characters to ${path}`;
      // Plain text in a file named .pdf is not a PDF: any .pdf is made as one.
      if (file.endsWith(".pdf")) {
        await abortable(yurt.fs.write(PDF_TEXT_PATH, text), signal);
        await makePdf(makePdfCommand(PDF_TEXT_PATH, file), wrote, signal);
        return `${wrote}; ${pdfMade(file)}`;
      }
      await abortable(yurt.fs.write(path, text), signal);
      if (file !== DEMO_TEXT_PATH) return wrote;
      await makePdf(MAKE_DEMO_PDF, wrote, signal);
      return `${wrote}; ${DEMO_PDF_MADE}`;
    },
    async setColor(color, signal) {
      // Models do leave out the # or use capitals.
      const hex = color.trim().toLowerCase().replace(/^#?/, "#");
      if (!DEMO_COLOR.test(hex)) {
        throw new Error(`no color ${color}; give its #rrggbb value`);
      }
      await abortable(yurt.fs.write(DEMO_COLOR_PATH, hex), signal);
      const set = `the PDF's text is ${hex}`;
      const text = await runCommand(
        yurt,
        `test -f ${DEMO_TEXT_PATH}`,
        EXEC_TIMEOUT_MS,
        DEFAULT_MAX_OUTPUT_BYTES,
        signal,
      );
      if (!("code" in text) || text.code !== 0) {
        return `${set} once its text is written`;
      }
      await makePdf(MAKE_DEMO_PDF, set, signal);
      return `${set}; ${DEMO_PDF_MADE}`;
    },
    async readFile(path, signal) {
      const checked = checkPath(path);
      const result = await runCommand(
        yurt,
        `cat -- ${quoted(checked)}`,
        120_000,
        64 * 1024 * 1024,
        signal,
      );
      if ("stillRunning" in result) {
        throw new Error(`read ${path}: process is still running`);
      }
      if (result.code !== 0) {
        throw new Error(`read ${path}: exit ${result.code ?? result.signal}`);
      }
      if (result.stdoutTruncated) {
        throw new Error(`read ${path}: larger than 64 MiB`);
      }
      return result.stdout;
    },
  };
}

export function waitForSandbox(
  yurt: Yurt,
  start: () => void,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return Promise.reject(cancelled());
  if (yurt.status === "idle") start();
  return abortable(yurt.ready, signal);
}

/** Whether the sandbox has a python3, for the system prompt. Only the
 * probe's own "no python3" code says no: a python3 without the Python set
 * (the slim image's python package) is still one, and the prompt promises
 * no more than "Python 3". A probe that fails or exits any other way says
 * yes, the prompt the agent always had. */
export async function sandboxHasPython(
  tools: Tools,
  signal: AbortSignal,
): Promise<boolean> {
  try {
    const result = await tools.exec(PYTHON_PROBE_COMMAND, signal);
    return result.code !== PYTHON_MISSING_EXIT;
  } catch {
    return true;
  }
}
