import {
  defaultHostState,
  KernelHostInterface,
  pumpPtyMaster,
  s,
} from "@yurt/kernel-host-interface-js";
import { stageImage } from "@yurt/stage-image";

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

const DEFAULT_ENV: Record<string, string> = {
  HOME: "/",
  PATH: "/bin:/usr/bin:/usr/local/bin",
  PWD: "/",
  USER: "root",
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
  env.show("loading image");
  const image = await env.fetchBytes("./playground.yurtimg");
  const mk = await KernelHostInterface.load(kernel, defaultHostState());
  const files = new Map<string, Uint8Array>();
  await stageImage(mk, image, undefined, files);
  const sh = files.get("/bin/sh");
  if (sh === undefined) {
    throw new Error("playground image is missing /bin/sh");
  }

  env.show("starting ash");
  const user = await mk.spawnUserProcessWithArgsAsync(sh, [s("/bin/sh")], {
    ...DEFAULT_ENV,
  });
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

const page = globalThis as typeof globalThis & {
  document?: {
    getElementById(
      id: string,
    ): { textContent: string | null } | null;
  };
  crossOriginIsolated?: boolean;
};

async function runPage(): Promise<void> {
  const { createPlaygroundTerminal } = await import("./terminal.ts");
  const status = page.document?.getElementById("status");
  const termHost = page.document?.getElementById("term");
  if (termHost === null || termHost === undefined) {
    throw new Error("missing #term");
  }
  const term = createPlaygroundTerminal(termHost);
  await bootPlayground({
    isolated: page.crossOriginIsolated === true,
    fetchBytes: fetchPlaygroundBytes,
    show: (text) => {
      if (status) status.textContent = text;
    },
    term,
  });
}

if (import.meta.main || !("Deno" in globalThis)) {
  await runPage();
}
