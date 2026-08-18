import {
  defaultHostState,
  KernelHostInterface,
  METHOD,
  pumpPtyMaster,
  s,
} from "@yurt/kernel-host-interface-js";
import { setPidCredentials, stageYurtimg } from "./stage.ts";

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
};

const LOGIN_USER = "user";
const LOGIN_UID = 1000;
const LOGIN_GID = 1000;
const LOGIN_HOME = "/home/user";

const DEFAULT_ENV: Record<string, string> = {
  HOME: LOGIN_HOME,
  PATH: "/bin:/usr/bin:/usr/local/bin",
  PWD: LOGIN_HOME,
  USER: LOGIN_USER,
  LOGNAME: LOGIN_USER,
  TERM: "xterm-256color",
};

export async function fetchPlaygroundBytes(path: string): Promise<Uint8Array> {
  const response = await fetch(path);
  if (!response.ok) {
    throw new Error(`fetch ${path} failed: ${response.status}`);
  }
  return new Uint8Array(await response.arrayBuffer());
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

  env.show("starting ash");
  const user = await mk.spawnUserProcessWithArgsAsync(sh, [s("/bin/sh")], {
    ...DEFAULT_ENV,
  });
  setPidCredentials(mk, user.pid, LOGIN_UID, LOGIN_GID);
  const { rc: chdirRc } = mk.kernelSyscall(
    METHOD.KERNEL_FS_CHDIR,
    user.pid,
    s(LOGIN_HOME),
    0,
  );
  if (Number(chdirRc) !== 0) {
    throw new Error(`chdir ${LOGIN_HOME} failed: rc=${chdirRc}`);
  }
  const pty = mk.attachHostPty(user.pid);
  mk.ptySetWinsize(pty, env.term.rows, env.term.cols);
  const encoder = new TextEncoder();
  const stopPump = pumpPtyMaster(mk, pty, (bytes) => env.term.write(bytes));
  env.term.onData((data) => mk.ptyMasterWrite(pty, encoder.encode(data)));
  env.term.onResize(({ rows, cols }) => mk.ptySetWinsize(pty, rows, cols));

  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    stopPump();
    try {
      mk.ptyMasterClose(pty);
    } catch {
      // guest may already have hung up
    }
  };

  void user.runStartAsync().catch((error) => {
    if (!stopped) {
      const message = error instanceof Error ? error.message : String(error);
      env.show(message);
    }
  }).finally(stop);

  env.show("");
  return { stop };
}
