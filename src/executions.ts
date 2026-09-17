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

type Streams<T> = {
  stdout: T;
  stderr: T;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
};
export type Output = Streams<string>;
/** The same with the bytes: what `fs.read` needs. */
export type RawOutput = Streams<Uint8Array>;

/** A SIGKILL went out (the deadline's, or a caller's) and the process has
 * not exited within the grace period. */
type StuckState = {
  timedOut: boolean;
  killAttempted: true;
  stillRunning: true;
};
export type Stuck = Output & StuckState;

/** What `wait` resolves to. `error` is set when the machinery failed
 * (the host could not signal or read), not the command. */
export type Result = ((Exit & Output) | Stuck) & { error?: string };

const EMPTY_RESULT: Result = {
  code: null,
  signal: null,
  timedOut: false,
  stdout: "",
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
};
export type RawResult = (Exit & RawOutput) | (RawOutput & StuckState);

export type ExecOptions = {
  /** The command's standard input, then end-of-file. */
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
  /** Bytes produced since the last take, drained. */
  takeStdout(): Uint8Array;
  takeStderr(): Uint8Array;
  /** What the process has written so far, without draining: for the
   * report on one that is stuck. Optional; a host without it reports
   * what the takes had. */
  peek?(): { stdout: Uint8Array; stderr: Uint8Array };
};

/** Start `line` with `stdin` as its input (at end-of-file when absent),
 * capturing at most `maxOutputBytes` (+1, so the caller can tell a cut)
 * per stream. How the streams travel is the host's: the native session
 * attaches pipes and feeds stdin while output drains; the in-tab host
 * keeps host stdio per pid, so a forked child's output is grouped after
 * its parent's and host-fed stdin never reaches a pipeline element
 * (yurtos-kernel#2817) -- that adapter redirects all three streams
 * through guest files instead. */
export type Spawner = (
  line: string,
  io: { stdin?: Uint8Array; maxOutputBytes: number },
) => Promise<SpawnedProcess>;

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
  get length(): number {
    return this.#length;
  }
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
  /** Settled once the drain has stopped and the outcome is known: an
   * exit, or the Stuck report. */
  done: Promise<Result>;
  /** The exit of a process that was reported stuck and then died. */
  late?: Result;
  /** The last signal sent (by the deadline or a caller), for the report. */
  killed?: string;
  /** When SIGKILL went out: the grace period for the Stuck report runs
   * from here, and only from here -- a caller's TERM is the process's to
   * handle. */
  killedAt?: number;
  timedOut: boolean;
  /** When the result may be dropped from the registry. */
  expiresAt?: number;
  /** Whether a caller has read the result (then it goes at once). */
  read: boolean;
};

export class ExecutionRegistry {
  #executions = new Map<string, Execution>();
  #next = 1;
  #pollMs: number;
  /** Spawns in flight: counted against the limit before their process
   * exists, so concurrent calls cannot slip past it. */
  #starting = 0;

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
    let n = this.#starting;
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
    const stdin = opts.stdin === undefined
      ? undefined
      : typeof opts.stdin === "string"
      ? encoder.encode(opts.stdin)
      : opts.stdin;
    const limit = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    this.#starting++;
    let process: SpawnedProcess;
    try {
      process = await this.spawner(line, { stdin, maxOutputBytes: limit });
    } finally {
      this.#starting--;
    }
    const id = `x${this.#next++}-${process.pid}`;
    const execution: Execution = {
      record: { id, state: "running", startedAt: Date.now() },
      process,
      stdout: new BoundedCapture(limit),
      stderr: new BoundedCapture(limit),
      done: Promise.resolve(EMPTY_RESULT),
      timedOut: false,
      read: false,
    };
    // In the map before the run starts: the run's first tick may kill
    // (a zero timeout), which looks the execution up by id.
    this.#executions.set(id, execution);
    execution.done = this.#run(execution, opts).catch((error) => {
      // A failure of the machinery (the signaller, the host), not of the
      // command: the execution is over as far as this registry can tell.
      this.#finish(execution);
      return {
        ...this.#output(execution),
        code: null,
        signal: null,
        timedOut: execution.timedOut,
        error: error instanceof Error ? error.message : String(error),
      };
    });
    return id;
  }

  async #run(execution: Execution, opts: ExecOptions): Promise<Result> {
    const { process, stdout, stderr } = execution;
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
    while (!exited) {
      stdout.push(process.takeStdout());
      stderr.push(process.takeStderr());
      const now = Date.now();
      // The deadline sends SIGKILL once, whatever a caller sent before;
      // the grace period runs from that SIGKILL (a caller's own SIGKILL
      // starts it too).
      if (!execution.timedOut && now >= deadline) {
        execution.timedOut = true;
        await this.kill(execution.record.id, "SIGKILL");
      }
      if (
        execution.killedAt !== undefined &&
        Date.now() >= execution.killedAt + KILL_GRACE_MS
      ) {
        execution.record.state = "stuck";
        const peeked = process.peek?.();
        if (peeked !== undefined) {
          stdout.push(peeked.stdout.subarray(stdout.length));
          stderr.push(peeked.stderr.subarray(stderr.length));
        }
        const stuck: Stuck = {
          ...this.#output(execution),
          timedOut: execution.timedOut,
          killAttempted: true,
          stillRunning: true,
        };
        tick.cancel();
        // Keep watching: it may still die, and then it is an exit, which
        // `wait` reports from then on.
        exit.then(() => {
          stdout.push(process.takeStdout());
          stderr.push(process.takeStderr());
          this.#finish(execution);
          execution.late = {
            ...this.#output(execution),
            code: execution.killed === undefined || code === 0 ? code : null,
            signal: execution.killed === undefined || code === 0
              ? null
              : execution.killed,
            timedOut: execution.timedOut,
          };
        });
        return stuck;
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

  /** The outcome, once there is one. A result read once is released. A
   * process reported stuck that has since died reports its exit. */
  async wait(id: string): Promise<Result> {
    const execution = this.#get(id);
    const result = execution.late ?? await execution.done;
    const final = execution.late ?? result;
    // A Stuck report is not the result: the exit, if it ever comes, is,
    // and it is read once from then on.
    if (!("stillRunning" in final)) execution.read = true;
    if (execution.record.state === "exited") this.#executions.delete(id);
    return final;
  }

  /** The same, with the bytes: what `fs.read` needs. */
  async waitRaw(id: string): Promise<RawResult> {
    const execution = this.#get(id);
    const result = execution.late ?? await execution.done;
    if (!("stillRunning" in result)) execution.read = true;
    if (execution.record.state === "exited") this.#executions.delete(id);
    const raw: RawOutput = {
      stdout: execution.stdout.bytes(),
      stderr: execution.stderr.bytes(),
      stdoutTruncated: execution.stdout.truncated,
      stderrTruncated: execution.stderr.truncated,
    };
    if ("stillRunning" in result) {
      return {
        ...raw,
        timedOut: true,
        killAttempted: true,
        stillRunning: true,
      };
    }
    return {
      ...raw,
      code: result.code,
      signal: result.signal,
      timedOut: result.timedOut,
    };
  }

  async kill(id: string, signal = "SIGKILL"): Promise<void> {
    const execution = this.#get(id);
    if (execution.record.state === "exited") return;
    const number = signalNumber(signal);
    execution.killed = signal.toUpperCase().startsWith("SIG")
      ? signal.toUpperCase()
      : `SIG${signal.toUpperCase()}`;
    if (number === SIGNALS.SIGKILL) execution.killedAt ??= Date.now();
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
