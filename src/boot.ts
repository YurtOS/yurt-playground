import {
  defaultHostState,
  KERNEL_PID,
  KernelHostInterface,
  METHOD,
  pumpPtyMaster,
  s,
  type SyncHandleYurtDevice,
  YurtMountError,
} from "@yurt/kernel-host-interface-js";
import { setPidCredentials, stageYurtimg, writeRamfsFile } from "./stage.ts";
import {
  browserStorageRoot,
  openGuestRoot,
  type OpfsDirectory,
} from "./opfs_root.ts";
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
import type { Spawner } from "./executions.ts";

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
  /** The image's pinned sha256, which keys its copy in browser storage;
   * hashed from the bytes when absent. */
  imageSha256?: string;
  /** Where the guest's root lives: OPFS by default in a worker. Tests hand
   * in a directory of their own; `null` keeps the root in kernel memory. */
  storage?: () => Promise<OpfsDirectory | undefined | null>;
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
  /** A guest file's bytes as the login shell would read them, or
   * `undefined` when there is no such file (the Jupyter connection file,
   * looked for without typing into the user's shell). */
  readFile?: (path: string) => Promise<Uint8Array | undefined>;
  /** The same, handing the process back: what a driver's `exec` runs
   * (src/executions.ts). */
  process?: Spawner;
  /** Deliver a signal to a process this page started. */
  signal?: (pid: number, signal: number) => Promise<void>;
  dialSandboxPort: (
    port: number,
  ) => ReturnType<KernelHostInterface["dialSandboxPort"]>;
  /** Where the guest's files are: in browser storage (OPFS) or, when that
   * could not be used, in the kernel's memory, and why. */
  storage?: { kind: "device" } | { kind: "memory"; reason: string };
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
/** No such process: a `SYS_KILLPG` to a group with no live member. */
const ESRCH = 3;

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

/** The pinned image's sha256: what keys its copy in browser storage. */
export async function pinnedImageSha256(): Promise<string> {
  return (await browserPins()).image.sha256;
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
  // The image is fetched only when something needs it: a reload whose
  // OPFS copy is complete never downloads or holds the 88 MB file.
  let image: Promise<Uint8Array> | undefined;
  const fetchImage = () => {
    if (image === undefined) {
      env.show("loading image");
      image = env.fetchBytes("./playground.yurtimg");
    }
    return image;
  };
  const root = await openGuestRoot({
    storage: (await (env.storage ?? browserStorageRoot)()) ?? undefined,
    imageSha256: env.imageSha256 ?? await sha256Hex(await fetchImage()),
    fetchImage,
    show: env.show,
  });
  let sh: Uint8Array | undefined;
  /** A file from the host, as `writeRamfsFile` would stage it. */
  let writeGuestFile: (
    path: string,
    bytes: Uint8Array,
    owner: { uid: number; gid: number },
  ) => void;
  /** Why the root is not the device, if it is not. */
  let refusal = root.kind === "memory" ? root.reason : undefined;
  if (root.kind === "device") {
    // Mounting over / needs root, as ramfs staging does.
    setPidCredentials(mk, KERNEL_PID, 0, 0);
    refusal = mountGuestRoot(mk, root.device);
  }
  if (root.kind === "device" && refusal === undefined) {
    // Nothing needs the compressed image any more; the closures below
    // share this scope, so drop it rather than keep 88 MB alive with them.
    image = undefined;
    const device = root.device;
    sh = device.readFile("/bin/sh");
    writeGuestFile = (path, bytes, owner) =>
      device.writeFile(path, bytes, {
        ...owner,
        mtimeNs: BigInt(Date.now()) * 1_000_000n,
      });
  } else {
    env.show(`unpacking image into memory (${refusal})`);
    const files = new Map<string, Uint8Array>();
    await stageYurtimg(mk, await fetchImage(), files);
    sh = files.get("/bin/sh");
    writeGuestFile = (path, bytes, owner) =>
      writeRamfsFile(mk, path, bytes, owner);
  }
  if (sh === undefined) {
    throw new Error("playground image is missing /bin/sh");
  }

  /** `/bin/sh` with `argv`, as the login user in the login home, leading
   * its own process group unless `ownGroup` is false. */
  const spawnShell = async (argv: string[], { ownGroup = true } = {}) => {
    const process = await mk.spawnUserProcessWithArgsAsync(
      sh,
      argv.map((arg) => s(arg)),
      { ...DEFAULT_ENV },
    );
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
    // in guest files, not in the per-pid buffers the reap drops. Best
    // effort, as the kernel runner's `reapRootBestEffort`: the exit status
    // is already known, and a failed wait must not replace it.
    const start = process.runStartAsync.bind(process);
    process.runStartAsync = () =>
      start().finally(() => {
        try {
          mk.reapHostChild(process.pid);
        } catch (error) {
          console.warn(
            `reap host-parented pid ${process.pid} failed: ${error}`,
          );
        }
      });
    return process;
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
      const tag = crypto.randomUUID();
      const path = (name: string) => `/tmp/.yurt-exec-${tag}.${name}`;
      const q = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
      const single = async (command: string) => {
        const p = await spawnShell(["/bin/sh", "-c", command]);
        p.closeStdin();
        await p.runStartAsync();
      };
      let stdinRedirect = "< /dev/null";
      if (io.stdin !== undefined) {
        // From the host, not through a process: host-fed stdin passes the
        // console line discipline (ICRNL, VEOF, VERASE, ISIG) and a 64 KiB
        // buffer, so bytes would be altered or dropped; a file written by
        // the kernel is exact at any size.
        // The login user's, so its sweep below can remove it from the
        // sticky /tmp.
        writeGuestFile(path("in"), io.stdin, {
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
        void single(
          `exec rm -f ${q(path("out"))} ${q(path("err"))} ${q(path("in"))}`,
        );
      const exited = process.runStartAsync().then((rc) => {
        done = true;
        return rc;
      }, (error) => {
        done = true;
        throw error;
      });
      // The registry reads the files right after the exit; the sweep comes
      // well after, whichever way the exit went.
      exited.finally(() => setTimeout(sweep, 5000)).catch(() => {});
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
    storage: refusal === undefined
      ? { kind: "device" }
      : { kind: "memory", reason: refusal },
    onOutput: output.onOutput,
    hushOutput: output.hushOutput,
  };
}

/**
 * Mount the device at `/`. A failure that left the kernel as it was is a
 * reason to stage into memory instead (returned, after the device's handles
 * are closed); one after the point of no return fails the boot.
 */
export function mountGuestRoot(
  mk: Pick<KernelHostInterface, "mountYurtDevice">,
  device: SyncHandleYurtDevice,
): string | undefined {
  try {
    mk.mountYurtDevice(s("/"), device);
    return undefined;
  } catch (error) {
    if (!(error instanceof YurtMountError) || error.kernelChanged) {
      throw new Error(
        `the guest root is half mounted, reload the page: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    device.close();
    return `mounting browser storage failed: ${error.message}`;
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    bytes as Uint8Array<ArrayBuffer>,
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
