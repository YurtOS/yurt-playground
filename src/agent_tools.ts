import type { Tools } from "./agent.ts";
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

export function createAgentTools(yurt: Yurt): Tools {
  return {
    async exec(cmd, signal) {
      const result = await runCommand(
        yurt,
        cmd,
        30_000,
        DEFAULT_MAX_OUTPUT_BYTES,
        signal,
      );
      return {
        code: "code" in result ? result.code : null,
        stdout: result.stdout,
        stderr: result.stderr,
      };
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
