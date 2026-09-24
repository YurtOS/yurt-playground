import type { SandboxPortConn } from "@yurt/kernel-host-interface-js";
import {
  createJupyterTransport,
  type JupyterConfig,
  type JupyterTransport,
} from "./jupyter_transport.ts";

export const JUPYTER_CONNECTION_FILE = "/tmp/yurt-kernel.json";
/** The launched ipykernel's pid, so a restart can kill exactly that process. */
export const JUPYTER_PID_FILE = "/tmp/yurt-kernel.pid";
export const JUPYTER_LOG_FILE = "/tmp/yurt-jupyter.log";
/** How long the guest waits for ipykernel to write its connection file. */
export const CONNECTION_FILE_WAIT_SECONDS = 240;
const JUPYTER_KEY = "yurt";
const encoder = new TextEncoder();

export type JupyterLaunchSession = {
  terminal: { write(bytes: Uint8Array): Promise<void> };
  /** Run a shell line as a process of the page's own, outside the user's
   * shell (the in-tab boot spawns it; the desktop page asks the launcher
   * for a host session, `nativeLaunchHooks`). Without it -- a launcher
   * older than the API -- the launch is typed at the prompt. */
  spawn?(line: string): Promise<void>;
  /** A guest file's bytes, or `undefined` when it does not exist yet (the
   * in-tab boot reads the VFS directly; the desktop page reads through the
   * launcher). Without it the connection-file wait is typed at the prompt
   * and the user's shell is busy with it for as long as ipykernel takes to
   * import -- twenty seconds and more in which anything the user types
   * queues behind it (yurtos-kernel#2824). */
  readFile?(path: string): Promise<Uint8Array | undefined>;
  dialSandboxPort(port: number): SandboxPortConn;
  onOutput(handler: (bytes: Uint8Array) => void): () => void;
  /** See PlaygroundSession.hushOutput; a session without one shows all. */
  hushOutput?(): { show(tail: Uint8Array): void };
};

/** The page types into the user's shell on its own behalf here (the
 * Jupyter launch, its stop); none of that is for the user to read. The
 * screen stays as it is until `marker` comes back, then whatever followed
 * the marker (the shell's next prompt) is shown on a cleared line. The
 * returned release shows the prompt-less state on failure; it is safe to
 * call twice. */
export function hushUntil(
  session: JupyterLaunchSession,
  marker: string,
): () => void {
  const hush = session.hushOutput?.();
  if (hush === undefined) return () => {};
  const decoder = new TextDecoder();
  let text = "";
  let released = false;
  const release = (tail = "") => {
    if (released) return;
    released = true;
    remove();
    hush.show(encoder.encode(`\r\x1b[2K${tail}`));
  };
  const remove = session.onOutput((chunk) => {
    text += decoder.decode(chunk, { stream: true });
    const at = text.indexOf(marker);
    if (at >= 0) {
      release(text.slice(at + marker.length).replace(/^\r?\n/, ""));
    }
  });
  return () => release();
}

/** One new piece of cell output. Keep IPC proportional to new output. */
export type JupyterStream = {
  stream: "stdout" | "stderr" | "display";
  text: string;
};

export type JupyterReply = {
  status: "ok" | "error";
  stdout: string;
  /** The `stderr` stream, apart from stdout: a driver reading the cell's
   * output needs to tell a warning from a result (yurt-playground#83). */
  stderr: string;
  display: string;
  traceback: string[];
};

/** shell, iopub, stdin, control, hb. */
export type KernelPorts = [number, number, number, number, number];

export function buildKernelLaunchCommand(
  connectionFile = JUPYTER_CONNECTION_FILE,
  ports?: KernelPorts,
): string {
  const line = [
    "python3 -m ipykernel_launcher",
    // Natively the kernel publishes a mapped port to the host only for a
    // non-loopback bind; in the tab the dial is loopback anyway.
    ports === undefined ? "--ip=127.0.0.1" : "--ip=0.0.0.0",
    "--transport=tcp",
    `--Session.key=${JUPYTER_KEY}`,
    `--f=${connectionFile}`,
  ];
  if (ports !== undefined) {
    // The desktop app maps exactly these to the host; in the tab ipykernel
    // picks its own and the connection file says which.
    const [shell, iopub, stdin, control, hb] = ports;
    line.push(
      `--shell=${shell}`,
      `--iopub=${iopub}`,
      `--stdin=${stdin}`,
      `--control=${control}`,
      `--hb=${hb}`,
    );
  }
  return line.join(" ");
}

/** The shell line that starts the kernel in the background and records
 * its pid. Typed at the prompt, so ipykernel is job [1] of the user's own
 * interactive shell and `kill %1` kills it (yurt-playground#82) -- what a
 * session without `spawn` gets: a launcher older than the /api/sessions
 * route. */
export function buildKernelStartLine(
  ports?: KernelPorts,
  connectionFile = JUPYTER_CONNECTION_FILE,
  logFile = JUPYTER_LOG_FILE,
  pidFile = JUPYTER_PID_FILE,
): string {
  return `${
    buildKernelLaunchCommand(connectionFile, ports)
  } >${logFile} 2>&1 & echo $! > ${pidFile}`;
}

/** The shell line a process of the page's own runs to become the kernel:
 * `sh -c` notes its pid (the kernel's, once it has exec'd) for the stop
 * command, then execs the launch with its output in the log. Typed at the
 * prompt instead, ipykernel was job [1] of the user's interactive shell
 * and `kill %1` killed it (yurt-playground#82); as its own process it is
 * in no job table. */
export function buildKernelOwnProcessLine(
  ports?: KernelPorts,
  connectionFile = JUPYTER_CONNECTION_FILE,
  logFile = JUPYTER_LOG_FILE,
  pidFile = JUPYTER_PID_FILE,
): string {
  return `echo $$ > ${pidFile}; exec ${
    buildKernelLaunchCommand(connectionFile, ports)
  } >${logFile} 2>&1`;
}

/** The shell line that stops a kernel started by `startGuestKernel` and
 * clears its files, so the next launch cannot read a stale connection file.
 * SIGKILL, not TERM: a kernel that is being restarted may be wedged. */
export function buildKernelStopCommand(
  connectionFile = JUPYTER_CONNECTION_FILE,
  pidFile = JUPYTER_PID_FILE,
): string {
  return `if [ -s ${pidFile} ]; then kill -KILL $(cat ${pidFile}) 2>/dev/null; ` +
    `wait $(cat ${pidFile}) 2>/dev/null; fi; rm -f ${connectionFile} ${pidFile}`;
}

/** Run one shell line in the guest and wait for its echo marker. */
async function runShell(
  session: JupyterLaunchSession,
  command: string,
  timeoutMs: number,
): Promise<void> {
  const marker = `YURT_SHELL_DONE_${Math.random().toString(36).slice(2, 8)}`;
  const typedMarker = marker.replace("DONE_", 'DONE_""');
  let text = "";
  let resolveOutput: (() => void) | undefined;
  const release = hushUntil(session, marker);
  const remove = session.onOutput((chunk) => {
    text += new TextDecoder().decode(chunk);
    if (text.includes(marker)) resolveOutput?.();
  });
  try {
    await session.terminal.write(
      encoder.encode(`${command}; echo ${typedMarker}\n`),
    );
    if (!text.includes(marker)) {
      await withTimeout(
        new Promise<void>((resolve) => resolveOutput = resolve),
        timeoutMs,
        `guest shell did not finish: ${command}`,
      );
    }
  } finally {
    remove();
    release();
  }
}

/** Kill the running guest kernel, if any, and drop its files. */
export async function stopGuestKernel(
  session: JupyterLaunchSession,
): Promise<void> {
  await runShell(session, buildKernelStopCommand(), 30_000);
}

/** Replace the guest kernel with a fresh process. */
export async function restartGuestKernel(
  session: JupyterLaunchSession,
  previous: JupyterTransport | undefined,
  ports?: KernelPorts,
): Promise<JupyterTransport> {
  await previous?.close().catch(() => {});
  await stopGuestKernel(session);
  return await startGuestKernel(session, ports);
}

// The PTY echoes the typed command, so the marker must not appear in it:
// the shell joins the two halves, the echo shows them quoted apart.
const CONNECTION_MARKER = "YURT_JUPYTER_CONNECTION_READY";
const TYPED_CONNECTION_MARKER = 'YURT_JUPYTER_CONNECTION_""READY';

export async function startGuestKernel(
  session: JupyterLaunchSession,
  ports?: KernelPorts,
  /** `connect` is the dial's retry budget -- production waits out a kernel
   * that is still binding its ports; a test that never dials says so
   * instead of paying the whole backoff (yurt-playground#123). */
  options: {
    pollMs?: number;
    connect?: { attempts?: number; delayMs?: number };
  } = {},
): Promise<JupyterTransport> {
  // Only what is typed into the user's shell needs hushing; a session that
  // spawns the launch and reads the file itself types nothing.
  const typesIntoShell = session.spawn === undefined ||
    session.readFile === undefined;
  const release = typesIntoShell
    ? hushUntil(session, CONNECTION_MARKER)
    : () => {};
  let connection: KernelConnection;
  try {
    if (session.spawn !== undefined) {
      await session.spawn(buildKernelOwnProcessLine(ports));
    } else {
      // No way to start a process of the page's own (a launcher older
      // than /api/sessions): the launch is a background job of the user's
      // shell (yurt-playground#82).
      await session.terminal.write(
        encoder.encode(`${buildKernelStartLine(ports)}\n`),
      );
    }
    try {
      connection = session.readFile !== undefined
        ? await pollConnectionFile(
          session.readFile,
          options.pollMs ?? CONNECTION_FILE_POLL_MS,
        )
        : await readConnectionFile(session);
    } catch (error) {
      // The launch is out (a process of its own, or a job of the shell)
      // and its connection file never came, or could not be read: it is
      // not left running for nobody. The stop is typed and hushed, and
      // its own failure is not the news here.
      await stopGuestKernel(session).catch(() => {});
      throw error;
    }
  } finally {
    release();
  }
  const config: JupyterConfig = {
    key: connection.key,
    shell: connection.shell_port,
    iopub: connection.iopub_port,
    stdin: connection.stdin_port,
    control: connection.control_port,
    heartbeat: connection.hb_port,
  };
  return await connectJupyterWithRetries(
    () =>
      createJupyterTransport(
        (port) => session.dialSandboxPort(port),
        config,
      ),
    waitForKernelInfo,
    options.connect,
  );
}

export async function connectJupyterWithRetries(
  createTransport: () => Promise<JupyterTransport>,
  waitForReady: (transport: JupyterTransport) => Promise<void>,
  options: { attempts?: number; delayMs?: number } = {},
): Promise<JupyterTransport> {
  const attempts = options.attempts ?? 50;
  const delayMs = options.delayMs ?? 100;
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    let transport: JupyterTransport | undefined;
    try {
      transport = await createTransport();
      await waitForReady(transport);
      return transport;
    } catch (error) {
      lastError = error;
      await transport?.close().catch(() => {});
      if (attempt + 1 < attempts) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
  throw new Error("Jupyter kernel did not become ready", { cause: lastError });
}

type KernelConnection = {
  shell_port: number;
  iopub_port: number;
  stdin_port: number;
  control_port: number;
  hb_port: number;
  key: string;
  transport: "tcp";
};

/** How often the connection file is looked for when the session can read
 * guest files. ipykernel writes it once, late; a look is one VFS open. */
const CONNECTION_FILE_POLL_MS = 500;

/** The connection file, polled through the session's own file read: the
 * user's shell is not involved at all. */
async function pollConnectionFile(
  readFile: (path: string) => Promise<Uint8Array | undefined>,
  pollMs: number,
): Promise<KernelConnection> {
  const deadline = performance.now() + CONNECTION_FILE_WAIT_SECONDS * 1000;
  const decoder = new TextDecoder();
  while (performance.now() < deadline) {
    const bytes = await readFile(JUPYTER_CONNECTION_FILE);
    if (bytes !== undefined && bytes.byteLength > 0) {
      // ipykernel writes the file in one go, but a look can land between
      // the create and the write: an unparsable file is "not yet".
      try {
        return JSON.parse(decoder.decode(bytes)) as KernelConnection;
      } catch {
        // fall through to the next look
      }
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  const log = await readFile(JUPYTER_LOG_FILE);
  const tail = log === undefined
    ? "(no log)"
    : decoder.decode(log).split("\n").slice(-30).join("\n");
  throw new Error(
    `Jupyter connection file was not written within ${CONNECTION_FILE_WAIT_SECONDS} s; kernel log:\n${tail}`,
  );
}

async function readConnectionFile(
  session: JupyterLaunchSession,
): Promise<KernelConnection> {
  const marker = CONNECTION_MARKER;
  const typedMarker = TYPED_CONNECTION_MARKER;
  const bytes: number[] = [];
  let text = "";
  let resolveOutput: (() => void) | undefined;
  const remove = session.onOutput((chunk) => {
    bytes.push(...chunk);
    text += new TextDecoder().decode(chunk);
    if (text.includes(marker)) resolveOutput?.();
  });
  try {
    // ipykernel writes the file once ipykernel + pyzmq are imported, which
    // is JIT-bound: ~30 s on a laptop, well past 60 s on a 2-vCPU CI runner.
    // Bounded, so a kernel that never starts still fails, and its log is
    // printed in that case so the failure names itself.
    await session.terminal.write(
      encoder.encode(
        `i=0; while [ ! -s ${JUPYTER_CONNECTION_FILE} ] && [ $i -lt ${CONNECTION_FILE_WAIT_SECONDS} ]; do ` +
          `sleep 1; i=$((i+1)); done; if [ -s ${JUPYTER_CONNECTION_FILE} ]; then ` +
          `cat ${JUPYTER_CONNECTION_FILE}; else echo KERNEL_LOG; tail -n 30 ${JUPYTER_LOG_FILE}; fi; ` +
          `echo ${typedMarker}\n`,
      ),
    );
    if (!text.includes(marker)) {
      await withTimeout(
        new Promise<void>((resolve) => resolveOutput = resolve),
        (CONNECTION_FILE_WAIT_SECONDS + 10) * 1000,
        "Jupyter connection file timed out",
      );
    }
    const jsonStart = text.indexOf("{");
    const jsonEnd = text.lastIndexOf("}");
    if (jsonStart < 0 || jsonEnd < jsonStart) {
      const log = text.slice(text.indexOf("KERNEL_LOG"), text.indexOf(marker));
      throw new Error(
        `Jupyter connection file was not written within ${CONNECTION_FILE_WAIT_SECONDS} s; kernel log:\n${log}`,
      );
    }
    const connection = JSON.parse(
      text.slice(jsonStart, jsonEnd + 1),
    ) as KernelConnection;
    if (connection.transport !== "tcp") {
      throw new Error("Jupyter transport is not tcp");
    }
    for (
      const port of [
        connection.shell_port,
        connection.iopub_port,
        connection.stdin_port,
        connection.control_port,
        connection.hb_port,
      ]
    ) {
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error("Jupyter connection file has an invalid port");
      }
    }
    return connection;
  } finally {
    remove();
  }
}

/** Bound on one cell of the terminal page's demo notebook. The first
 * execute after boot is JIT-bound like the boot itself: ~2 s on a laptop,
 * tens of seconds on a 2-vCPU CI runner. */
export const EXECUTE_TIMEOUT_MS = 120_000;

export async function executeCell(
  transport: JupyterTransport,
  code: string,
  options: {
    timeoutMs?: number;
    /** Called with each new output chunk; the reply remains complete. */
    onStream?: (chunk: JupyterStream) => void;
  } = {},
): Promise<JupyterReply> {
  const msgId = crypto.randomUUID();
  const output = {
    stdout: "",
    stderr: "",
    display: "",
    traceback: [] as string[],
  };
  let unsubscribe: (() => void) | undefined;
  const result = new Promise<JupyterReply>((resolve, reject) => {
    let gotReply = false;
    let gotIdle = false;
    let replyStatus: "ok" | "error" = "error";
    const finish = () => {
      if (!gotReply || !gotIdle) return;
      unsubscribe?.();
      unsubscribe = undefined;
      resolve({ status: replyStatus, ...output });
    };
    unsubscribe = transport.subscribe((message) => {
      if (message.parent_header.msg_id !== msgId) return;
      if (message.header.msg_type === "stream") {
        const text = String(message.content.text ?? "");
        const stream = message.content.name === "stderr" ? "stderr" : "stdout";
        output[stream] += text;
        options.onStream?.({ stream, text });
      } else if (
        message.header.msg_type === "display_data" ||
        message.header.msg_type === "execute_result"
      ) {
        const text = displayText(message.content.data);
        output.display += text;
        options.onStream?.({ stream: "display", text });
      } else if (message.header.msg_type === "error") {
        output.traceback.push(...asStrings(message.content.traceback));
      } else if (message.header.msg_type === "execute_reply") {
        gotReply = true;
        replyStatus = message.content.status === "ok" ? "ok" : "error";
        finish();
      } else if (
        message.header.msg_type === "status" &&
        message.content.execution_state === "idle"
      ) {
        gotIdle = true;
        finish();
      }
    });
    void transport.send({
      header: {
        msg_id: msgId,
        username: "user",
        session: msgId,
        msg_type: "execute_request",
        version: "5.3",
      },
      parent_header: {},
      metadata: {},
      content: {
        code,
        silent: false,
        store_history: true,
        user_expressions: {},
        allow_stdin: false,
        stop_on_error: true,
      },
    }).catch((error) => {
      unsubscribe?.();
      unsubscribe = undefined;
      reject(error);
    });
  });
  try {
    return await withTimeout(
      result,
      options.timeoutMs ?? EXECUTE_TIMEOUT_MS,
      "Jupyter execute timed out",
    );
  } finally {
    unsubscribe?.();
    unsubscribe = undefined;
  }
}

/**
 * Raise KeyboardInterrupt in whatever the kernel is running.
 *
 * `interrupt_request` goes on the control channel, which ipykernel serves
 * on a thread of its own, so it lands while the shell thread is inside a
 * cell -- which is the whole point. The running `executeCell` then
 * finishes the ordinary way, with the traceback on its error frame; there
 * is nothing to wait for here (yurt-playground#130).
 */
export function interruptKernel(transport: JupyterTransport): Promise<void> {
  const msgId = crypto.randomUUID();
  return transport.send({
    header: {
      msg_id: msgId,
      username: "user",
      session: msgId,
      msg_type: "interrupt_request",
      version: "5.3",
    },
    parent_header: {},
    metadata: {},
    content: {},
  }, "control");
}

async function waitForKernelInfo(transport: JupyterTransport): Promise<void> {
  const msgId = crypto.randomUUID();
  let unsubscribe: (() => void) | undefined;
  const result = new Promise<void>((resolve, reject) => {
    unsubscribe = transport.subscribe((message) => {
      if (
        message.parent_header.msg_id === msgId &&
        message.header.msg_type === "kernel_info_reply"
      ) {
        unsubscribe?.();
        unsubscribe = undefined;
        resolve();
      }
    });
    void transport.send({
      header: {
        msg_id: msgId,
        username: "user",
        session: msgId,
        msg_type: "kernel_info_request",
        version: "5.3",
      },
      parent_header: {},
      metadata: {},
      content: {},
    }).catch((error) => {
      unsubscribe?.();
      unsubscribe = undefined;
      reject(error);
    });
  });
  try {
    await withTimeout(result, 15_000, "Jupyter kernel-info timed out");
  } finally {
    unsubscribe?.();
    unsubscribe = undefined;
  }
}

function displayText(data: unknown): string {
  if (data === null || typeof data !== "object") return "";
  const text = (data as Record<string, unknown>)["text/plain"];
  return typeof text === "string" ? text : "";
}

function asStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: number | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
