import {
  defaultHostState,
  KernelHostInterface,
  METHOD,
  pumpPtyMaster,
  s,
} from "@yurt/kernel-host-interface-js";
import { setPidCredentials, stageYurtimg } from "./stage.ts";
import {
  createSessionController,
  type PtyTransport,
  type SessionController,
} from "./session_controller.ts";
import {
  type ArtifactProgress,
  fetchPinnedArtifact,
} from "./artifact_fetch.ts";
import { partsFetch } from "./image_parts.ts";
import { parsePins, type Pins } from "./pins.ts";

export type PlaygroundTerm = {
  cols: number;
  rows: number;
  write: (data: string | Uint8Array) => void;
  onData: (handler: (data: string) => void) => void;
  onResize: (
    handler: (size: { rows: number; cols: number }) => void,
  ) => void;
};

export type PlaygroundEnv = {
  isolated: boolean;
  fetchBytes: (path: string) => Promise<Uint8Array>;
  show: (text: string) => void;
  term: PlaygroundTerm;
};

export type PlaygroundSession = {
  stop: () => void;
  controller: SessionController;
  terminal: PtyTransport;
  /** Run a shell line as a process of the page's own (`sh -c`), as the
   * login user in the login home, with no terminal: what the Jupyter
   * kernel is started as, so it is no job of the user's shell. Absent on
   * the desktop app's page, which has only the terminal. */
  spawn?: (line: string) => Promise<void>;
  dialSandboxPort: (
    port: number,
  ) => ReturnType<KernelHostInterface["dialSandboxPort"]>;
  onOutput: (handler: (bytes: Uint8Array) => void) => () => void;
  /** Keep the shell's output off the screen until `show(tail)`: what the
   * page types into the user's shell on its own behalf (the Jupyter
   * launch) is not for the user to read. `tail` is written as the display
   * resumes. */
  hushOutput: () => { show(tail: Uint8Array): void };
};

/** The shell's output goes to the screen and to whoever asked to see it
 * (the Jupyter launch reads its connection file from here). */
export function outputFanout(term: PlaygroundTerm) {
  const handlers = new Set<(bytes: Uint8Array) => void>();
  let hushed = false;
  return {
    push(bytes: Uint8Array) {
      if (!hushed) term.write(bytes);
      for (const handler of handlers) handler(bytes);
    },
    onOutput(handler: (bytes: Uint8Array) => void) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    hushOutput() {
      hushed = true;
      return {
        show(tail: Uint8Array) {
          hushed = false;
          term.write(tail);
        },
      };
    },
  };
}

const LOGIN_USER = "user";
const LOGIN_UID = 1000;
const LOGIN_GID = 1000;
const LOGIN_HOME = "/home/user";

const DEFAULT_ENV: Record<string, string> = {
  HOME: LOGIN_HOME,
  PATH: "/bin:/usr/bin:/usr/local/bin",
  PYTHONHOME: "/usr/local",
  PWD: LOGIN_HOME,
  USER: LOGIN_USER,
  LOGNAME: LOGIN_USER,
  TERM: "xterm-256color",
};

let pinsPromise: Promise<Pins> | undefined;

async function browserPins(): Promise<Pins> {
  pinsPromise ??= fetch("./pins.json").then(async (response) => {
    if (!response.ok) {
      throw new Error(`fetch ./pins.json failed: ${response.status}`);
    }
    return parsePins(await response.json());
  });
  try {
    return await pinsPromise;
  } catch (error) {
    pinsPromise = undefined;
    throw error;
  }
}

export async function fetchPlaygroundBytes(
  path: string,
  onProgress?: (progress: ArtifactProgress) => void,
): Promise<Uint8Array> {
  const pins = await browserPins();
  const isKernel = path.includes("yurt_kernel.wasm");
  const cacheStorage = typeof caches === "undefined" ? undefined : caches;
  return await fetchPinnedArtifact(isKernel ? pins.kernelWasm : pins.image, {
    url: path,
    cacheName: "yurt-playground-artifacts-v1",
    cacheStorage,
    // The image is published in parts (Cloudflare Pages' 25 MiB file cap).
    fetch: isKernel ? undefined : partsFetch(),
    onProgress,
  });
}

export async function bootPlayground(
  env: PlaygroundEnv,
): Promise<PlaygroundSession> {
  if (env.isolated !== true) {
    env.show("need COOP/COEP");
    throw new Error("not crossOriginIsolated");
  }

  env.show("loading kernel");
  const kernel = await env.fetchBytes("./yurt_kernel.wasm");
  env.show("compiling kernel");
  const mk = await KernelHostInterface.load(kernel, defaultHostState());
  env.show("loading image");
  const image = await env.fetchBytes("./playground.yurtimg");
  env.show("unpacking image");
  const files = new Map<string, Uint8Array>();
  await stageYurtimg(mk, image, files);
  const sh = files.get("/bin/sh");
  if (sh === undefined) {
    throw new Error("playground image is missing /bin/sh");
  }

  /** `/bin/sh` with `argv`, as the login user in the login home. */
  const spawnShell = async (argv: string[]) => {
    const process = await mk.spawnUserProcessWithArgsAsync(
      sh,
      argv.map((arg) => s(arg)),
      { ...DEFAULT_ENV },
    );
    setPidCredentials(mk, process.pid, LOGIN_UID, LOGIN_GID);
    const { rc: chdirRc } = mk.kernelSyscall(
      METHOD.KERNEL_FS_CHDIR,
      process.pid,
      s(LOGIN_HOME),
      0,
    );
    if (Number(chdirRc) !== 0) {
      throw new Error(`chdir ${LOGIN_HOME} failed: rc=${chdirRc}`);
    }
    return process;
  };
  env.show("starting ash");
  const user = await spawnShell(["/bin/sh"]);
  const pty = mk.attachHostPty(user.pid);
  mk.ptySetWinsize(pty, env.term.rows, env.term.cols);
  const encoder = new TextEncoder();
  const output = outputFanout(env.term);
  const stopPump = pumpPtyMaster(mk, pty, output.push);
  const terminal: PtyTransport = {
    write(bytes) {
      mk.ptyMasterWrite(pty, bytes);
      return Promise.resolve();
    },
    close() {
      mk.ptyMasterClose(pty);
    },
  };
  const controller = createSessionController({ pty: terminal });
  let stopped = false;
  env.term.onData((data) => {
    // Keys after the shell has gone have nowhere to go; the pty is closed
    // and a write to it is an error, not a keystroke.
    if (stopped || controller.state !== "ready") return;
    void controller.current.pty.write(encoder.encode(data));
  });
  env.term.onResize(({ rows, cols }) => mk.ptySetWinsize(pty, rows, cols));

  const stop = () => {
    if (stopped) return;
    stopped = true;
    stopPump();
    try {
      controller.current.pty.close();
    } catch {
      // guest may already have hung up
    }
  };

  void user.runStartAsync().then(() => {
    // `exit` at the prompt: the shell is done, the sandbox is still there
    // (the notebook's kernel keeps answering). Say so where the prompt
    // was, and in the status, instead of failing the next keystroke.
    if (!stopped) {
      env.term.write(
        "\r\n[the shell exited; reload the page for a new one]\r\n",
      );
      env.show("shell exited");
    }
  }).catch((error) => {
    if (!stopped) {
      const message = error instanceof Error ? error.message : String(error);
      env.show(message);
    }
  }).finally(stop);

  env.show("");
  return {
    stop,
    controller,
    terminal,
    async spawn(line) {
      const process = await spawnShell(["/bin/sh", "-c", line]);
      // Nothing feeds it: stdin is at end-of-file from the start.
      process.closeStdin();
      void process.runStartAsync().catch(() => {
        // Its exit is the kernel's business (the connection file, the log);
        // nothing here waits on it.
      });
    },
    dialSandboxPort: (port) => mk.dialSandboxPort(port),
    onOutput: output.onOutput,
    hushOutput: output.hushOutput,
  };
}
