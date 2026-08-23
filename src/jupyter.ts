import type { SandboxPortConn } from "@yurt/kernel-host-interface-js";
import {
  createJupyterTransport,
  type JupyterConfig,
  type JupyterTransport,
} from "./jupyter_transport.ts";

export const JUPYTER_CONNECTION_FILE = "/tmp/yurt-kernel.json";
export const JUPYTER_PID_FILE = "/tmp/yurt-jupyter.pid";
export const JUPYTER_STARTUP_TIMEOUT_MS = 200_000;
const JUPYTER_KEY = "yurt";
const encoder = new TextEncoder();

export type JupyterLaunchSession = {
  terminal: { write(bytes: Uint8Array): Promise<void> };
  dialSandboxPort(port: number): SandboxPortConn;
  onOutput(handler: (bytes: Uint8Array) => void): () => void;
};

export type JupyterReply = {
  status: "ok" | "error";
  stdout: string;
  display: string;
  traceback: string[];
};

export function buildKernelLaunchCommand(
  connectionFile = JUPYTER_CONNECTION_FILE,
): string {
  return [
    "python3 -m ipykernel_launcher",
    "--ip=127.0.0.1",
    "--transport=tcp",
    `--Session.key=${JUPYTER_KEY}`,
    `--f=${connectionFile}`,
  ].join(" ");
}

export async function startGuestKernel(
  session: JupyterLaunchSession,
): Promise<JupyterTransport> {
  await session.terminal.write(
    encoder.encode(
      `${buildKernelLaunchCommand()} >/tmp/yurt-jupyter.log 2>&1 & ` +
        `echo $! >${JUPYTER_PID_FILE}\n`,
    ),
  );
  const connection = await readConnectionFile(session);
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

async function readConnectionFile(
  session: JupyterLaunchSession,
): Promise<KernelConnection> {
  const marker = "YURT_JUPYTER_CONNECTION_READY";
  const bytes: number[] = [];
  let text = "";
  let resolveOutput: (() => void) | undefined;
  const remove = session.onOutput((chunk) => {
    bytes.push(...chunk);
    text += new TextDecoder().decode(chunk);
    if (text.includes(marker)) resolveOutput?.();
  });
  try {
    await session.terminal.write(
      encoder.encode(
        `i=0; while [ ! -s ${JUPYTER_CONNECTION_FILE} ] && [ $i -lt 180 ]; do ` +
          `sleep 1; i=$((i+1)); done; cat ${JUPYTER_CONNECTION_FILE}; ` +
          `echo ${marker}\n`,
      ),
    );
    if (!text.includes(marker)) {
      await withTimeout(
        new Promise<void>((resolve) => resolveOutput = resolve),
        JUPYTER_STARTUP_TIMEOUT_MS,
        "Jupyter connection file timed out",
      );
    }
    const jsonStart = text.indexOf("{");
    const jsonEnd = text.lastIndexOf("}");
    if (jsonStart < 0 || jsonEnd < jsonStart) {
      throw new Error(
        `Jupyter connection file was not printed; output=${
          JSON.stringify(text.slice(-4000))
        }`,
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

export async function executeCell(
  transport: JupyterTransport,
  code: string,
  timeoutMs = 15_000,
): Promise<JupyterReply> {
  const msgId = crypto.randomUUID();
  const output = { stdout: "", display: "", traceback: [] as string[] };
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
        output.stdout += String(message.content.text ?? "");
      } else if (
        message.header.msg_type === "display_data" ||
        message.header.msg_type === "execute_result"
      ) {
        output.display += displayText(message.content.data);
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
    return await withTimeout(result, timeoutMs, "Jupyter execute timed out");
  } finally {
    unsubscribe?.();
    unsubscribe = undefined;
  }
}

export async function shutdownGuestKernel(
  transport: JupyterTransport,
): Promise<void> {
  const msgId = crypto.randomUUID();
  let unsubscribe: (() => void) | undefined;
  const reply = new Promise<void>((resolve, reject) => {
    unsubscribe = transport.subscribe((message) => {
      if (
        message.parent_header.msg_id === msgId &&
        message.header.msg_type === "shutdown_reply"
      ) resolve();
    });
    void transport.sendControl({
      header: {
        msg_id: msgId,
        username: "user",
        session: msgId,
        msg_type: "shutdown_request",
        version: "5.3",
      },
      parent_header: {},
      metadata: {},
      content: { restart: false },
    }).catch(reject);
  });
  try {
    await withTimeout(reply, 15_000, "Jupyter shutdown timed out");
  } finally {
    unsubscribe?.();
  }
}

export async function waitForGuestKernelExit(
  session: Pick<JupyterLaunchSession, "terminal" | "onOutput">,
): Promise<void> {
  const marker = "YURT_JUPYTER_EXITED";
  const failed = "YURT_JUPYTER_EXIT_TIMEOUT";
  let output = "";
  let resolveOutput: (() => void) | undefined;
  const remove = session.onOutput((chunk) => {
    output += new TextDecoder().decode(chunk);
    if (output.includes(marker) || output.includes(failed)) {
      resolveOutput?.();
    }
  });
  try {
    await session.terminal.write(
      encoder.encode(
        `i=0; while kill -0 "$(cat ${JUPYTER_PID_FILE})" 2>/dev/null && ` +
          `[ $i -lt 30 ]; do sleep 1; i=$((i+1)); done; ` +
          `if kill -0 "$(cat ${JUPYTER_PID_FILE})" 2>/dev/null; then ` +
          `echo ${failed}; else echo ${marker}; fi\n`,
      ),
    );
    if (!output.includes(marker) && !output.includes(failed)) {
      await withTimeout(
        new Promise<void>((resolve) => resolveOutput = resolve),
        35_000,
        "Jupyter process exit timed out",
      );
    }
    if (output.includes(failed)) {
      throw new Error("Jupyter process did not exit");
    }
  } finally {
    remove();
  }
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
