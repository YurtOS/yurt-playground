import {
  defaultHostState,
  KERNEL_PID,
  KernelHostInterface,
  METHOD,
  pumpPtyMaster,
  s,
  type SandboxSealImage,
} from "@yurt/kernel-host-interface-js";
import {
  drainDirtyPaths,
  type LayerEntry,
  setPidCredentials,
  stageLayer,
  stageYurtimg,
  vfsReaddir,
  vfsReadFile,
  vfsReadlink,
  vfsStat,
  writeRamfsFile,
  writeRamfsTree,
} from "./stage.ts";
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
import { captureLayer } from "./python_layer.ts";
import { watchGuestMemoryRefusals } from "./memory_refused.ts";
import { parsePins, type Pins } from "./pins.ts";
import {
  checkPythonSet,
  decodeWhileChecking,
  fetchVerifiedSnapshot,
  pinnedSnapshot,
} from "./sandbox_snapshot.ts";
import type { Spawner, WaitStatus } from "./executions.ts";
import {
  decodeWaitRecord,
  WAIT_RECORD_LEN,
  waitRequest,
} from "./wait_record.ts";

/** Linux errnos the host's reap tells apart. */
const ECHILD = 10;
const EAGAIN = 11;

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
  /** The image to boot ({@link browserImagePath}); the full image when
   * unset. */
  imagePath?: string;
  /** A sealed sandbox to restore instead of booting `imagePath`
   * (src/sandbox_snapshot.ts). */
  snapshotPath?: string;
  /** The Python set the live index offers now, as a layer key
   * (src/python_layer.ts): null when the site installs none, undefined
   * when the index cannot be asked. A snapshot of another set is not
   * restored. */
  livePythonSet?: () => Promise<string | null | undefined>;
  show: (text: string) => void;
  term: PlaygroundTerm;
  /** The browser refused a new process its memory; only a reload helps. */
  memoryRefused?: () => void;
};

export type PlaygroundSession = {
  stop: () => void;
  /** Stop, and free the kernel with every guest in it: for a session that
   * is done for good (a short-lived one, say), not one a page shows. */
  dispose?: () => void;
  controller: SessionController;
  terminal: PtyTransport;
  /** Run a shell line as a process of the page's own (`sh -c`), as the
   * login user in the login home, with no terminal: what the Jupyter
   * kernel is started as, so it is no job of the user's shell. Absent on
   * the desktop app's page, which has only the terminal. */
  spawn?: (line: string) => Promise<void | { exited: Promise<unknown> }>;
  /** A guest file's bytes as the login shell would read them, or
   * `undefined` when there is no such file (the Jupyter connection file,
   * looked for without typing into the user's shell). */
  readFile?: (path: string) => Promise<Uint8Array | undefined>;
  /** The same, handing the process back: what a driver's `exec` runs
   * (src/executions.ts). */
  process?: Spawner;
  /** Write guest files from the host, root's (0644, in root's
   * directories), creating their directories: what a package install
   * stages (src/packages.ts) before `sudo pkg` reads it. */
  writeFiles?: (files: { path: string; bytes: Uint8Array }[]) => void;
  /** The guest's filesystem as layers (src/python_layer.ts): what changed
   * since the last drain, those paths read out as a layer, and a layer
   * written in. All as the kernel, with no guest process. */
  layer?: {
    drainChanged(): string[];
    capture(touched: string[]): LayerEntry[];
    apply(entries: LayerEntry[]): void;
  };
  /** Kill the shell, wait for every guest process to be gone, and seal the
   * sandbox: what `?snapshot=capture` ships (src/sandbox_snapshot.ts). The
   * session is over afterwards. */
  seal?: () => Promise<SandboxSealImage>;
  /** Deliver a signal to a process this page started. */
  signal?: (pid: number, signal: number) => Promise<void>;
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

// The login setup and what a boot stages beside the image are part of a
// sandbox snapshot: a change to them is a new BOOT_SETUP
// (src/sandbox_snapshot.ts).
const LOGIN_USER = "user";
const LOGIN_UID = 1000;
const LOGIN_GID = 1000;
const LOGIN_HOME = "/home/user";
/** No such process: a `SYS_KILLPG` to a group with no live member. */
const ESRCH = 3;
const SIGKILL = 9;
const MIB = 1024 * 1024;

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

/** The full image: what the desktop app and the CLI run, and where the
 * suspend/resume kernel stages its standard library from. */
export const FULL_IMAGE_PATH = "./playground.yurtimg";
/** The slim image (`browserImage` in the pins): no Python, no Node. */
export const SLIM_IMAGE_PATH = "./playground-slim.yurtimg";

/** The image the browser boots: the slim one when the train pins one,
 * else the full one. */
export async function browserImagePath(): Promise<string> {
  return (await browserPins()).browserImage === undefined
    ? FULL_IMAGE_PATH
    : SLIM_IMAGE_PATH;
}

/** The pins the page was built with (`./pins.json`). */
export function playgroundPins(): Promise<Pins> {
  return browserPins();
}

export async function fetchPlaygroundBytes(
  path: string,
  onProgress?: (progress: ArtifactProgress) => void,
): Promise<Uint8Array> {
  const pins = await browserPins();
  const isKernel = path.includes("yurt_kernel.wasm");
  const isSlim = path.includes("playground-slim.yurtimg");
  if (isSlim && pins.browserImage === undefined) {
    throw new Error("pins.json names no slim image (browserImage)");
  }
  const pin = isKernel
    ? pins.kernelWasm
    : isSlim
    ? pins.browserImage!
    : pins.image;
  const cacheStorage = typeof caches === "undefined" ? undefined : caches;
  return await fetchPinnedArtifact(pin, {
    url: path,
    cacheName: "yurt-playground-artifacts-v1",
    cacheStorage,
    // The image is published in parts (Cloudflare Pages' 25 MiB file cap).
    fetch: isKernel ? undefined : partsFetch(),
    onProgress,
  });
}

/** Up to `cap` bytes of a guest file, read through the kernel host
 * interface on behalf of `pid` (its credentials apply): the same
 * open/read/close the worker host uses for guest modules. No guest
 * process is involved, so what a command wrote is read back exactly. */
function readGuestFile(
  mk: KernelHostInterface,
  pid: number,
  path: string,
  cap: number,
): Uint8Array {
  const pathBytes = new TextEncoder().encode(path);
  const open = new Uint8Array(12 + pathBytes.length);
  const view = new DataView(open.buffer);
  view.setUint32(0, 0, true); // O_RDONLY
  view.setUint32(4, 0, true);
  view.setUint32(8, pathBytes.length, true);
  open.set(pathBytes, 12);
  const opened = mk.kernelSyscall(METHOD.KERNEL_FS_OPEN, pid, open, 0);
  const fd = Number(opened.rc);
  if (fd < 0) return new Uint8Array();
  const fdRequest = new Uint8Array(4);
  new DataView(fdRequest.buffer).setUint32(0, fd, true);
  const chunks: Uint8Array[] = [];
  let total = 0;
  const chunkCap = Math.max(512, Math.min(cap, mk.scratchLen - 16));
  try {
    while (total < cap) {
      const read = mk.kernelSyscall(
        METHOD.KERNEL_FS_READ,
        pid,
        fdRequest,
        chunkCap,
      );
      const count = Number(read.rc);
      if (count <= 0) break;
      chunks.push(
        read.response.subarray(0, Math.min(count, cap - total)).slice(),
      );
      total += count;
    }
  } finally {
    mk.kernelSyscall(METHOD.KERNEL_FS_CLOSE, pid, fdRequest, 0);
  }
  const out = new Uint8Array(Math.min(total, cap));
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

/**
 * The address space each guest process reserves on JavaScriptCore
 * (yurtos-kernel#2996). A browser reserves a shared wasm memory's whole
 * maximum up front, and Safari holds about 32 GiB of them per tab; every
 * guest build declares 4 GiB, and the kernel's default is the whole 1 GiB
 * sandbox budget, so a burst of a few dozen execs ran Safari out. A quarter
 * GiB leaves room for more than 100 processes and several times what
 * CPython needs here (ipykernel 81 MiB, a 2000x2000 NumPy matmul 98 MiB). A
 * process that outgrows it gets ENOMEM; the sandbox budget still caps them
 * all.
 */
export const GUEST_MEMORY_RESERVATION_BYTES = 256 * 1024 * 1024;

/**
 * Whether this engine is JavaScriptCore (Safari, and every iOS browser).
 * Chromium and Edge also say `AppleWebKit/`, always with a `Chrome/`
 * token; Firefox and Deno say neither. The same test as the kernel's
 * `workerTeardownWaitsOnCompiles`.
 */
export function isJavaScriptCore(
  userAgent: string | undefined = globalThis.navigator?.userAgent,
): boolean {
  if (userAgent === undefined) return false;
  return /AppleWebKit\//.test(userAgent) && !/Chrome\//.test(userAgent);
}

/**
 * The host state every in-browser kernel is built with. Only on
 * JavaScriptCore does it set a per-process reservation: V8 and SpiderMonkey
 * reserve address space lazily and have no per-tab cap that a few dozen
 * 1 GiB memories reach, so there each process keeps the whole sandbox
 * budget (a 1.1 GB `np.zeros((12000, 12000))` or a large clang TU still
 * fits), and the budget still caps them all together.
 */
export function playgroundHostState(
  userAgent: string | undefined = globalThis.navigator?.userAgent,
):
  & ReturnType<typeof defaultHostState>
  & { guestMemoryReservationBytes?: number } {
  // Kernels older than yurtos-kernel#3115 do not read the field.
  // Only JavaScriptCore runs out of shared-memory reservations.
  if (!isJavaScriptCore(userAgent)) {
    return defaultHostState();
  }
  return {
    ...defaultHostState(),
    guestMemoryReservationBytes: GUEST_MEMORY_RESERVATION_BYTES,
  };
}

/** Load a kernel for an in-browser sandbox. Every page and worker goes
 *  through this or {@link restorePlaygroundKernel}, so on JavaScriptCore
 *  each one reserves {@link GUEST_MEMORY_RESERVATION_BYTES} per guest
 *  process (see {@link playgroundHostState}). */
export function loadPlaygroundKernel(
  kernel: Uint8Array,
): Promise<KernelHostInterface> {
  return KernelHostInterface.load(kernel, playgroundHostState());
}

/** Restore a sealed in-browser sandbox; see {@link loadPlaygroundKernel}. */
export function restorePlaygroundKernel(
  kernel: Uint8Array,
  image: Parameters<typeof KernelHostInterface.restore>[1],
): ReturnType<typeof KernelHostInterface.restore> {
  return KernelHostInterface.restore(kernel, image, playgroundHostState());
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
  /** The rest of the boot on a loaded or restored kernel; a boot that
   * fails there leaves nothing running: its kernel goes (a page may boot
   * again, as a fresh sandbox after a stalled install). */
  const start = async (mk: KernelHostInterface, restored: boolean) => {
    const stopWatchingRefusals = watchGuestMemoryRefusals(
      mk,
      () => env.memoryRefused?.(),
    );
    try {
      return await startPlayground(env, mk, stopWatchingRefusals, restored);
    } catch (error) {
      stopWatchingRefusals();
      try {
        mk.dispose();
      } catch {
        // Already gone.
      }
      throw error;
    }
  };
  const bootImage = async () => {
    env.show("compiling kernel");
    return await start(await loadPlaygroundKernel(kernel), false);
  };
  const snapshotPath = env.snapshotPath;
  if (snapshotPath === undefined) return await bootImage();
  // A restored kernel that then fails to start its shell falls back too.
  return (await snapshotOrBoot(
    async () => start(await restoreSnapshot(env, kernel, snapshotPath), true),
    bootImage,
  )).kernel;
}

/**
 * `?snapshot=1`'s kernel: the restored snapshot, or the image's boot when
 * the snapshot cannot be had -- none pinned, one of another build, a
 * download that fails or is not the pinned bytes, a file that does not
 * inflate, a restore that is refused. The snapshot only saves time; the
 * image boot is always there, so any of these is a console note, not the
 * boot's failure.
 */
export async function snapshotOrBoot<K>(
  restore: () => Promise<K>,
  boot: () => Promise<K>,
): Promise<{ kernel: K; restored: boolean }> {
  try {
    return { kernel: await restore(), restored: true };
  } catch (error) {
    console.warn(
      `[snapshot] ${
        error instanceof Error ? error.message : String(error)
      }; booting the image instead`,
    );
    return { kernel: await boot(), restored: false };
  }
}

/** A kernel over a sealed sandbox with no process in it: its filesystem is
 * all in the kernel's memory, so nothing is staged. */
async function restoreSnapshot(
  env: PlaygroundEnv,
  kernel: Uint8Array,
  path: string,
): Promise<KernelHostInterface> {
  const started = performance.now();
  env.show("loading snapshot");
  // A pin of another build is refused before anything is downloaded, a
  // file whose own header says so before the kernel's memory is allocated
  // (SnapshotMismatch both).
  const pins = await browserPins();
  const pin = pinnedSnapshot(pins);
  // Only this frame holds the decoded memory (~545 MiB), and only until
  // the restore copied it: a fallback boot must not run beside it. The
  // Python set the capture installed must be the one an install would get
  // now, as for a stored layer (src/python_layer.ts); the live index is
  // asked while the snapshot downloads, and a different answer stops it.
  let image: SandboxSealImage | undefined = await decodeWhileChecking(
    (signal) =>
      fetchVerifiedSnapshot(
        path,
        pin,
        undefined,
        (loaded, total) =>
          env.show(
            `loading snapshot ${(loaded / MIB).toFixed(1)} of ${
              (total / MIB).toFixed(1)
            } MiB`,
          ),
        signal,
      ),
    pin.builtFrom,
    (async () => checkPythonSet(pin.builtFrom, await env.livePythonSet?.()))(),
  );
  const fetched = performance.now();
  const memoryBytes = image.kernelMemory.byteLength;
  env.show("restoring snapshot");
  let restored: Awaited<ReturnType<typeof restorePlaygroundKernel>>;
  try {
    restored = await restorePlaygroundKernel(kernel, image);
  } finally {
    image = undefined;
  }
  if (restored.processes.length !== 0) {
    restored.host.dispose();
    throw new Error("a sandbox snapshot must hold no process");
  }
  console.log(
    `[snapshot] ${memoryBytes} bytes of kernel memory: ` +
      `fetched+inflated in ${Math.round(fetched - started)} ms, ` +
      `restored in ${Math.round(performance.now() - fetched)} ms`,
  );
  return restored.host;
}

/**
 * Work put off until after something settles, and then a delay: an exec's
 * sweep of its /tmp files, 5 s after the exit. A seal must not race it --
 * a sweep that spawns after the seal began would be a process the seal
 * either catches mid-run or misses. `hurry` starts what is waiting at
 * once, and anything that becomes due later without the delay; `idle` is
 * true once every piece of work has run to its end.
 */
export class DeferredWork {
  private waiting = new Map<number, () => void>();
  /** Deferred and not yet run to its end. */
  private busy = 0;
  private hurried = false;

  defer(
    after: Promise<unknown>,
    run: () => Promise<void>,
    delayMs: number,
  ): void {
    this.busy++;
    const start = () => {
      run().catch(() => {}).finally(() => this.busy--);
    };
    const due = () => {
      if (this.hurried) {
        start();
        return;
      }
      const timer = setTimeout(() => {
        this.waiting.delete(timer);
        start();
      }, delayMs);
      this.waiting.set(timer, start);
    };
    after.then(due, due);
  }

  hurry(): void {
    this.hurried = true;
    for (const [timer, start] of this.waiting) {
      clearTimeout(timer);
      start();
    }
    this.waiting.clear();
  }

  get idle(): boolean {
    return this.busy === 0;
  }
}

/** The live processes a seal kills: none while a sweep is being spawned
 * (its pid is not known yet), and never a sweep's own. */
export function processesToKill(
  live: { pid: number }[],
  sweeps: { pids: ReadonlySet<number>; starting: number },
): number[] {
  if (sweeps.starting > 0) return [];
  return live.map((p) => p.pid).filter((pid) => !sweeps.pids.has(pid));
}

/** The rest of {@link bootPlayground}, on its loaded (or restored) kernel. */
async function startPlayground(
  env: PlaygroundEnv,
  mk: Awaited<ReturnType<typeof loadPlaygroundKernel>>,
  stopWatchingRefusals: () => void,
  restored: boolean,
): Promise<PlaygroundSession> {
  let sh: Uint8Array | undefined;
  if (restored) {
    sh = readGuestFile(mk, KERNEL_PID, "/bin/sh", 64 * 1024 * 1024);
    if (sh.byteLength === 0) sh = undefined;
  } else {
    env.show("loading image");
    const image = await env.fetchBytes(env.imagePath ?? FULL_IMAGE_PATH);
    env.show("unpacking image");
    const files = new Map<string, Uint8Array>();
    await stageYurtimg(mk, image, files);
    sh = files.get("/bin/sh");
  }
  if (sh === undefined) {
    throw new Error("playground image is missing /bin/sh");
  }
  const shell = sh;

  /** Each exec's sweep of its files (below), which a seal runs first. */
  const sweeps = new DeferredWork();
  /** A seal has begun: the page starts no process of its own any more. */
  let sealing = false;
  /** The seal is being taken: nothing starts at all, a sweep included. */
  let sealed = false;
  /** The sweeps' own processes, which a seal lets finish: a pid joins as
   * soon as the kernel has it and leaves when the sweep has ended. */
  const sweepProcs = { pids: new Set<number>(), starting: 0 };

  /** `/bin/sh` with `argv`, as the login user in the login home, leading
   * its own process group unless `ownGroup` is false. */
  const spawnShell = async (
    argv: string[],
    { ownGroup = true, spawned = (_pid: number) => {} } = {},
  ) => {
    if (sealed) throw new Error("the sandbox is sealed");
    const process = await mk.spawnUserProcessWithArgsAsync(
      shell,
      argv.map((arg) => s(arg)),
      { ...DEFAULT_ENV },
    );
    spawned(process.pid);
    setPidCredentials(mk, process.pid, LOGIN_UID, LOGIN_GID);
    // Its own process group, which everything it starts inherits, so
    // `signal` below reaches a pipeline or a background job with it.
    // setpgid(0, 0) as the pid: target 0 is the caller, pgid 0 its pid.
    if (ownGroup) {
      const { rc } = mk.kernelSyscall(
        METHOD.SYS_SETPGID,
        process.pid,
        new Uint8Array(8),
        0,
      );
      if (Number(rc) !== 0) {
        throw new Error(`setpgid pid=${process.pid} failed: rc=${rc}`);
      }
    }
    const { rc: chdirRc } = mk.kernelSyscall(
      METHOD.KERNEL_FS_CHDIR,
      process.pid,
      s(LOGIN_HOME),
      0,
    );
    if (Number(chdirRc) !== 0) {
      throw new Error(`chdir ${LOGIN_HOME} failed: rc=${chdirRc}`);
    }
    // Reap it at its exit: the host is its parent, so nothing in the guest
    // waits for it, and until the host does it stays in the process table
    // as a zombie (yurt-playground#148, yurtos-kernel#2813). Its output is
    // in guest files, not in the per-pid buffers the reap drops. The reap
    // is where the wait status is: the kernel's record, read whole, since
    // `runStartAsync`'s number folds a signal death into 128+n and
    // `reapHostChild`'s cannot tell exit 9 from SIGKILL (#204). Best
    // effort, as the kernel runner's `reapRootBestEffort`: a failed wait
    // leaves `runStartAsync`'s number, and must not replace it.
    let status: WaitStatus | undefined;
    const reap = () => {
      const { rc, response } = mk.kernelSyscall(
        METHOD.SYS_WAIT,
        KERNEL_PID,
        waitRequest(process.pid),
        WAIT_RECORD_LEN,
      );
      const n = Number(rc);
      // Not an exited child of the host: nothing to reap, and no status.
      if (n === -ECHILD || n === -EAGAIN) return;
      if (n !== WAIT_RECORD_LEN) throw new Error(`SYS_WAIT rc=${rc}`);
      status = decodeWaitRecord(response);
    };
    const start = process.runStartAsync.bind(process);
    process.runStartAsync = () =>
      start().finally(() => {
        try {
          reap();
        } catch (error) {
          console.warn(
            `reap host-parented pid ${process.pid} failed: ${error}`,
          );
        }
      });
    return Object.assign(process, {
      /** Its wait status, once `runStartAsync` has settled and reaped it. */
      waitStatus: (): WaitStatus | undefined => status,
    });
  };
  env.show("starting ash");
  // Not a group leader: attaching the terminal makes the login shell a
  // session leader, which the kernel refuses a group leader (EPERM).
  const user = await spawnShell(["/bin/sh"], { ownGroup: false });
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
  env.term.onResize(({ rows, cols }) => {
    // A stopped session's kernel may be freed: a fresh sandbox after a
    // stalled install shares the page's terminal with it.
    if (!stopped) mk.ptySetWinsize(pty, rows, cols);
  });

  const stop = () => {
    if (stopped) return;
    stopped = true;
    // A stopped session's kernel must not raise the banner for whatever
    // session the page runs next.
    stopWatchingRefusals();
    stopPump();
    try {
      controller.current.pty.close();
    } catch {
      // guest may already have hung up
    }
  };

  const userExited = user.runStartAsync().then(() => {
    // `exit` at the prompt: the shell is done, the sandbox is still there
    // (the notebook's kernel keeps answering). Say so where the prompt
    // was, and in the status, instead of failing the next keystroke.
    // A seal kills it on purpose; the capture says what happens next.
    if (!stopped && !sealing) {
      env.term.write(
        "\r\n[the shell exited; reload the page for a new one]\r\n",
      );
      env.show("shell exited");
    }
  }).catch((error) => {
    if (!stopped && !sealing) {
      const message = error instanceof Error ? error.message : String(error);
      env.show(message);
    }
  }).finally(stop);

  env.show("");
  return {
    stop,
    dispose() {
      stop();
      mk.dispose();
    },
    controller,
    terminal,
    async spawn(line) {
      if (sealing) throw new Error("the sandbox is being sealed");
      const process = await spawnShell(["/bin/sh", "-c", line]);
      // Nothing feeds it: stdin is at end-of-file from the start.
      process.closeStdin();
      // Its exit is the kernel's business (the connection file, the log);
      // the launch only watches for it, to stop waiting for a file a dead
      // kernel will not write.
      // The wait status when the host has one, as `process` gives: a
      // signal death is then a signal, not a folded 128+n.
      const exited = process.runStartAsync().then((rc) =>
        process.waitStatus() ?? rc
      );
      exited.catch(() => {});
      return { exited };
    },
    async process(line, io) {
      // The host keeps stdio per pid: a forked child's output lands in its
      // own buffer (grouped after the parent's, not interleaved), and
      // host-fed stdin never reaches a pipeline element
      // (yurtos-kernel#2817). Guest files have neither problem, so the
      // command's three streams are redirected through /tmp and the
      // outputs read back once it has exited, bounded, by an exec'd
      // `head` -- a single command, whose own stdout the host does
      // capture. `line` ends in the exec of the command, so the redirects
      // bind to the command and every child inherits them.
      if (sealing) throw new Error("the sandbox is being sealed");
      const tag = crypto.randomUUID();
      const path = (name: string) => `/tmp/.yurt-exec-${tag}.${name}`;
      const q = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
      // A sweep is known to the seal from before its spawn (`starting`)
      // and by its pid from the moment the kernel has one, so the seal
      // never kills it; its pid leaves the set when it has ended.
      const single = async (command: string) => {
        let pid: number | undefined;
        sweepProcs.starting++;
        let p: Awaited<ReturnType<typeof spawnShell>>;
        try {
          p = await spawnShell(["/bin/sh", "-c", command], {
            spawned: (id) => {
              pid = id;
              sweepProcs.pids.add(id);
            },
          });
        } finally {
          sweepProcs.starting--;
        }
        try {
          p.closeStdin();
          await p.runStartAsync();
        } finally {
          if (pid !== undefined) sweepProcs.pids.delete(pid);
        }
      };
      let stdinRedirect = "< /dev/null";
      if (io.stdin !== undefined) {
        // From the host, not through a process: host-fed stdin passes the
        // console line discipline (ICRNL, VEOF, VERASE, ISIG) and a 64 KiB
        // buffer, so bytes would be altered or dropped; a file written by
        // the kernel is exact at any size.
        // The login user's, so its sweep below can remove it from the
        // sticky /tmp.
        writeRamfsFile(mk, path("in"), io.stdin, {
          uid: LOGIN_UID,
          gid: LOGIN_GID,
        });
        stdinRedirect = `< ${q(path("in"))}`;
      }
      const process = await spawnShell([
        "/bin/sh",
        "-c",
        `${line} > ${q(path("out"))} 2> ${q(path("err"))} ${stdinRedirect}`,
      ]);
      process.closeStdin();
      // Read back once the command has exited, one byte past the bound
      // so the registry sees the cut and says so; the files go afterwards.
      let done = false;
      const sweep = () =>
        single(
          `exec rm -f ${q(path("out"))} ${q(path("err"))} ${q(path("in"))}`,
        );
      const exited = process.runStartAsync().then((rc) => {
        done = true;
        return process.waitStatus() ?? rc;
      }, (error) => {
        done = true;
        throw error;
      });
      // The registry reads the files right after the exit; the sweep comes
      // well after, whichever way the exit went (at once during a seal).
      sweeps.defer(exited, sweep, 5000);
      const cap = io.maxOutputBytes + 1;
      const taken = { out: false, err: false };
      const take = (stream: "out" | "err") => {
        if (!done || taken[stream]) return new Uint8Array();
        taken[stream] = true;
        return readGuestFile(mk, user.pid, path(stream), cap);
      };
      return {
        pid: process.pid,
        exited,
        takeStdout: () => take("out"),
        takeStderr: () => take("err"),
        // The files are readable while the command runs: what a stuck
        // process has written so far.
        peek: () => ({
          stdout: readGuestFile(mk, user.pid, path("out"), cap),
          stderr: readGuestFile(mk, user.pid, path("err"), cap),
        }),
      };
    },
    async seal() {
      sealing = true;
      // An exec's sweep runs now rather than 5 s after its exit, and the
      // seal waits for it. Every other guest process goes, whoever started
      // it -- the shell and its background jobs, a running exec, a
      // Packages install -- and keeps going until none is left: a dying
      // process's sweep, or a child it forked, shows up in a later look.
      sweeps.hurry();
      const deadline = Date.now() + 30_000;
      for (;;) {
        const live = mk.listProcesses().filter((p) =>
          p.pid !== KERNEL_PID && p.state !== "exited"
        );
        if (live.length === 0 && sweeps.idle) break;
        for (const pid of processesToKill(live, sweepProcs)) {
          mk.killProcess(pid, SIGKILL);
        }
        if (Date.now() > deadline) {
          throw new Error(
            `cannot seal: processes still alive: ${
              live.map((p) => `${p.pid}:${p.state}`).join(",")
            }${sweeps.idle ? "" : " (and an exec's file sweep)"}`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      await userExited;
      sealed = true;
      return await mk.sealSandbox();
    },
    writeFiles(files) {
      for (const { path, bytes } of files) writeRamfsTree(mk, path, bytes);
    },
    layer: {
      drainChanged: () => drainDirtyPaths(mk),
      capture: (touched) =>
        captureLayer({
          stat: (path) => vfsStat(mk, path),
          readFile: (path, size) => vfsReadFile(mk, path, size),
          readlink: (path) => vfsReadlink(mk, path),
          readdir: (path) => vfsReaddir(mk, path),
        }, touched),
      apply: (entries) => stageLayer(mk, entries),
    },
    signal(pid, signal) {
      // Every process `spawnShell` starts leads its own group, which its
      // children (a pipeline, a background job) share: killpg(pid, signal)
      // as the login shell, whose user may signal its own processes.
      const request = new Uint8Array(8);
      const view = new DataView(request.buffer);
      view.setUint32(0, pid, true);
      view.setUint32(4, signal, true);
      const { rc } = mk.kernelSyscall(METHOD.SYS_KILLPG, user.pid, request, 0);
      // An empty group: the execution is already gone.
      if (Number(rc) !== 0 && Number(rc) !== -ESRCH) {
        return Promise.reject(
          new Error(`killpg pgid=${pid} sig=${signal} failed: rc=${rc}`),
        );
      }
      return Promise.resolve();
    },
    // The Jupyter connection file, looked for by the page itself: nothing is
    // typed into the user's shell for it (yurtos-kernel#2824). Read as the
    // login shell, whose credentials apply; a missing file is `undefined`.
    readFile(path) {
      // Enough for the kernel log the failure message tails.
      const bytes = readGuestFile(mk, user.pid, path, 4 * 1024 * 1024);
      return Promise.resolve(bytes.byteLength > 0 ? bytes : undefined);
    },
    dialSandboxPort: (port) => mk.dialSandboxPort(port),
    onOutput: output.onOutput,
    hushOutput: output.hushOutput,
  };
}
