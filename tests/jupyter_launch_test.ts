import { assertEquals, assertRejects } from "@std/assert";
import {
  buildKernelLaunchCommand,
  JUPYTER_CONNECTION_FILE,
  type JupyterLaunchSession,
  readConnectionFile,
} from "../src/jupyter.ts";

Deno.test("Jupyter launch uses Python 3 and a guest connection file", () => {
  assertEquals(
    buildKernelLaunchCommand(),
    `python3 -m ipykernel_launcher --ip=127.0.0.1 --transport=tcp ` +
      `--Session.key=yurt --f=${JUPYTER_CONNECTION_FILE}`,
  );
});

const CONNECTION = {
  shell_port: 5001,
  iopub_port: 5002,
  stdin_port: 5003,
  control_port: 5004,
  hb_port: 5005,
  key: "yurt",
  transport: "tcp",
};

// A PTY echoes what is typed before the shell runs it, so the command text
// reaches onOutput first; only the shell's own output is the answer.
function echoingSession(
  answer: () => string,
): JupyterLaunchSession {
  const handlers = new Set<(bytes: Uint8Array) => void>();
  const emit = (text: string) => {
    for (const handler of handlers) handler(new TextEncoder().encode(text));
  };
  return {
    terminal: {
      write(bytes) {
        emit(new TextDecoder().decode(bytes).replace("\n", "\r\n"));
        setTimeout(() => emit(answer()), 20);
        return Promise.resolve();
      },
    },
    dialSandboxPort() {
      throw new Error("not used");
    },
    onOutput(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
  };
}

Deno.test("connection file is read from the shell's output, not the typed command's echo", async () => {
  const session = echoingSession(() =>
    `${JSON.stringify(CONNECTION)}\r\nYURT_JUPYTER_CONNECTION_READY\r\n`
  );
  assertEquals((await readConnectionFile(session)).shell_port, 5001);
});

Deno.test("an empty connection file is reported rather than parsed from the echo", async () => {
  const session = echoingSession(() => "YURT_JUPYTER_CONNECTION_READY\r\n");
  await assertRejects(
    () => readConnectionFile(session),
    Error,
    "Jupyter connection file was not printed",
  );
});
