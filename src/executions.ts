/**
 * Commands run on the sandbox's behalf by a driver (an agent, a test), as
 * processes of the page's own: `window.yurt.spawn/exec` (yurt-playground#79).
 *
 * Host-agnostic: a `Spawner` starts a shell line and hands back the process
 * (in-tab, the kernel host interface's `UserProcess`; natively, a session).
 * This module owns everything above that — the registry of executions and
 * their opaque ids, bounded output capture, stdin fed concurrently with
 * draining, the timeout that kills, and the "killed but still running"
 * state a CPU-bound guest can reach (yurtos-kernel#2811).
 */

export type Exit = {
  /** Numeric status, or null when a signal ended the process. */
  code: number | null;
  /** "SIGKILL" etc., or null on a normal exit. */
  signal: string | null;
  timedOut: boolean;
};

export type Output = {
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
};

/** The deadline sent the kill and the process has not exited. */
export type Stuck = Output & {
  timedOut: true;
  killAttempted: true;
  stillRunning: true;
};

/** What `wait` resolves to. */
export type Result = (Exit & Output) | Stuck;

export type ExecOptions = {
  /** Fed after the process starts, alongside output draining, then closed. */
  stdin?: string | Uint8Array;
  timeoutMs?: number;
  /** Per stream; capture stops there and the flag says so. */
  maxOutputBytes?: number;
  /** Default: the login home. */
  cwd?: string;
  /** Merged over the login environment; a string sets (`""` included),
   * null removes. */
  env?: Record<string, string | null>;
};

export const DEFAULT_TIMEOUT_MS = 120_000;
export const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
export const MAX_ACTIVE_EXECUTIONS = 16;
export const RETENTION_MS = 10 * 60 * 1000;
/** After the kill, how long to wait for the exit before declaring `Stuck`. */
export const KILL_GRACE_MS = 2000;

/** What a host gives back for a started shell line. */
export type SpawnedProcess = {
  pid: number;
  /** Resolves with the exit status once the process is done. */
  exited: Promise<number>;
  feedStdin(bytes: Uint8Array): void;
  closeStdin(): void;
  /** Bytes produced since the last take, drained. */
  takeStdout(): Uint8Array;
  takeStderr(): Uint8Array;
};

export type Spawner = (line: string) => Promise<SpawnedProcess>;

export type ExecutionState = "running" | "exited" | "stuck";

export type ExecutionRecord = {
  id: string;
  state: ExecutionState;
  startedAt: number;
};

const encoder = new TextEncoder();

/** Quote for the guest shell. */
export function quoted(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

/** The shell line that runs `cmd` with the options applied: a working
 * directory, then `env` for the merge (BusyBox `env -u` removes), then the
 * command under its own `sh -c`. */
export function buildExecLine(cmd: string, opts: ExecOptions = {}): string {
  const parts: string[] = [];
  if (opts.cwd !== undefined) parts.push(`cd ${quoted(opts.cwd)} || exit 126;`);
  const env = Object.entries(opts.env ?? {});
  parts.push("exec");
  if (env.length > 0) {
    parts.push("env");
    for (const [key, value] of env) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        throw new Error(`env: ${JSON.stringify(key)} is not a variable name`);
      }
      parts.push(value === null ? `-u ${key}` : quoted(`${key}=${value}`));
    }
  }
  parts.push("sh", "-c", quoted(cmd));
  return parts.join(" ");
}

/** Signal names the kill accepts, and their numbers (Linux). */
const SIGNALS: Record<string, number> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGKILL: 9,
  SIGUSR1: 10,
  SIGUSR2: 12,
  SIGTERM: 15,
};

export function signalNumber(signal: string): number {
  const name = signal.toUpperCase().startsWith("SIG")
    ? signal.toUpperCase()
    : `SIG${signal.toUpperCase()}`;
  const number = SIGNALS[name];
  if (number === undefined) throw new Error(`unknown signal ${signal}`);
  return number;
}

/** A capture that stops growing at its limit and remembers that it did. */
class BoundedCapture {
  #chunks: Uint8Array[] = [];
  #length = 0;
  truncated = false;
  constructor(readonly limit: number) {}
  push(bytes: Uint8Array): void {
    if (bytes.byteLength === 0) return;
    const room = this.limit - this.#length;
    if (room <= 0) {
      this.truncated = true;
      return;
    }
    if (bytes.byteLength > room) {
      this.#chunks.push(bytes.subarray(0, room));
      this.#length += room;
      this.truncated = true;
      return;
    }
    this.#chunks.push(bytes);
    this.#length += bytes.byteLength;
  }
  bytes(): Uint8Array {
    const out = new Uint8Array(this.#length);
    let at = 0;
    for (const chunk of this.#chunks) {
      out.set(chunk, at);
      at += chunk.byteLength;
    }
    return out;
  }
}

type Execution = {
  record: ExecutionRecord;
  process: SpawnedProcess;
  stdout: BoundedCapture;
  stderr: BoundedCapture;
  /** Settled once the drain has stopped and the outcome is known. */
  done: Promise<Result>;
  /** Set when a kill was sent (by the deadline or a caller). */
  killed?: string;
  timedOut: boolean;
  /** When the result may be dropped from the registry. */
  expiresAt?: number;
  /** Whether a caller has read the result (then it goes at once). */
  read: boolean;
};

/** `Result` with the bytes instead of text: what `fs.read` needs. */
export type RawResult = Omit<Result, "stdout" | "stderr"> & {
  stdout: Uint8Array;
  stderr: Uint8Array;
};

export class ExecutionRegistry {
  #executions = new Map<string, Execution>();
  #next = 1;
  #pollMs: number;

  constructor(
    private readonly spawner: Spawner,
    /** How to deliver a signal to a pid: a process of its own, so a
     * kill needs no shell of the user's. */
    private readonly signaller: (pid: number, signal: number) => Promise<void>,
    options: { pollMs?: number } = {},
  ) {
    this.#pollMs = options.pollMs ?? 50;
  }

  list(): ExecutionRecord[] {
    this.#expire();
    return [...this.#executions.values()].map((e) => ({ ...e.record }));
  }

  active(): number {
    let n = 0;
    for (const e of this.#executions.values()) {
      if (e.record.state !== "exited") n++;
    }
    return n;
  }

  async spawn(cmd: string, opts: ExecOptions = {}): Promise<string> {
    this.#expire();
    if (this.active() >= MAX_ACTIVE_EXECUTIONS) {
      throw new Error(
        `TooManyExecutions: ${MAX_ACTIVE_EXECUTIONS} are running or stuck`,
      );
    }
    const line = buildExecLine(cmd, opts);
    const process = await this.spawner(line);
    const id = `x${this.#next++}-${process.pid}`;
    const limit = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    const execution: Execution = {
      record: { id, state: "running", startedAt: Date.now() },
      process,
      stdout: new BoundedCapture(limit),
      stderr: new BoundedCapture(limit),
      done: Promise.resolve({
        code: null,
        signal: null,
        timedOut: false,
        stdout: "",
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
      }),
      timedOut: false,
      read: false,
    };
    execution.done = this.#run(execution, opts);
    this.#executions.set(id, execution);
    return id;
  }

  async #run(execution: Execution, opts: ExecOptions): Promise<Result> {
    const { process, stdout, stderr } = execution;
    // stdin after the start, in one go alongside the drain: the kernel's
    // stdin buffer takes what the reader has not consumed, so this cannot
    // block on the pipe the way a pre-start write into a full pipe would.
    if (opts.stdin !== undefined) {
      const bytes = typeof opts.stdin === "string"
        ? encoder.encode(opts.stdin)
        : opts.stdin;
      if (bytes.byteLength > 0) process.feedStdin(bytes);
    }
    process.closeStdin();
    let exited = false;
    let code = 0;
    const exit = process.exited.then((c) => {
      exited = true;
      code = c;
    }, () => {
      exited = true;
      code = -1;
    });
    const tick = new Tick();
    const deadline = Date.now() + (opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    let killDeadline: number | undefined;
    while (!exited) {
      stdout.push(process.takeStdout());
      stderr.push(process.takeStderr());
      const now = Date.now();
      if (execution.killed === undefined && now >= deadline) {
        execution.timedOut = true;
        await this.kill(execution.record.id, "SIGKILL");
      }
      if (execution.killed !== undefined) {
        killDeadline ??= Date.now() + KILL_GRACE_MS;
        if (Date.now() >= killDeadline) {
          execution.record.state = "stuck";
          const stuck: Stuck = {
            ...this.#output(execution),
            timedOut: true,
            killAttempted: true,
            stillRunning: true,
          };
          tick.cancel();
          // Keep watching: it may still die, and then it is an exit.
          exit.then(() => {
            stdout.push(process.takeStdout());
            stderr.push(process.takeStderr());
            this.#finish(execution);
          });
          return stuck;
        }
      }
      await Promise.race([exit, tick.wait(this.#pollMs)]);
    }
    tick.cancel();
    stdout.push(process.takeStdout());
    stderr.push(process.takeStderr());
    this.#finish(execution);
    // A process that the deadline killed reports the signal, not a status;
    // one that exited on its own before the kill landed keeps its status.
    if (execution.killed !== undefined && code !== 0) {
      return {
        ...this.#output(execution),
        code: null,
        signal: execution.killed,
        timedOut: execution.timedOut,
      };
    }
    return {
      ...this.#output(execution),
      code,
      signal: null,
      timedOut: execution.timedOut,
    };
  }

  #finish(execution: Execution): void {
    execution.record.state = "exited";
    execution.expiresAt = Date.now() + RETENTION_MS;
  }

  #output(execution: Execution): Output {
    const decoder = new TextDecoder();
    return {
      stdout: decoder.decode(execution.stdout.bytes()),
      stderr: decoder.decode(execution.stderr.bytes()),
      stdoutTruncated: execution.stdout.truncated,
      stderrTruncated: execution.stderr.truncated,
    };
  }

  #get(id: string): Execution {
    const execution = this.#executions.get(id);
    if (execution === undefined) throw new Error(`no execution ${id}`);
    return execution;
  }

  /** The outcome, once there is one. A result read once is released. */
  async wait(id: string): Promise<Result> {
    const execution = this.#get(id);
    const result = await execution.done;
    execution.read = true;
    if (execution.record.state === "exited") this.#executions.delete(id);
    return result;
  }

  /** The same, with the bytes: what `fs.read` needs. */
  async waitRaw(id: string): Promise<RawResult> {
    const execution = this.#get(id);
    const result = await execution.done;
    execution.read = true;
    if (execution.record.state === "exited") this.#executions.delete(id);
    const { stdout: _s, stderr: _e, ...outcome } = result;
    return {
      ...outcome,
      stdout: execution.stdout.bytes(),
      stderr: execution.stderr.bytes(),
    };
  }

  async kill(id: string, signal = "SIGKILL"): Promise<void> {
    const execution = this.#get(id);
    if (execution.record.state === "exited") return;
    const number = signalNumber(signal);
    execution.killed = signal.toUpperCase().startsWith("SIG")
      ? signal.toUpperCase()
      : `SIG${signal.toUpperCase()}`;
    await this.signaller(execution.process.pid, number);
  }

  #expire(): void {
    const now = Date.now();
    for (const [id, execution] of this.#executions) {
      if (
        execution.record.state === "exited" &&
        (execution.read || (execution.expiresAt ?? Infinity) <= now)
      ) {
        this.#executions.delete(id);
      }
    }
  }
}

/** A sleep that can be cut short, so a process exiting mid-poll leaves no
 * timer behind. */
class Tick {
  #timer: number | undefined;
  #resolve: (() => void) | undefined;
  wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.#resolve = resolve;
      this.#timer = setTimeout(() => {
        this.#timer = undefined;
        resolve();
      }, ms);
    });
  }
  cancel(): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#resolve?.();
  }
}
