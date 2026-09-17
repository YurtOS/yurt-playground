/**
 * `window.yurt`: the sandbox for a program, not a person (yurt-playground#79).
 *
 * A driver -- an agent, a test -- gets commands with an exit status and
 * separate streams, files in and out, and a status it can wait on, without
 * typing into the terminal or reading xterm's rows. Everything runs as a
 * process of the page's own (src/executions.ts, in the coordinator worker);
 * this module is the page-side face and the file helpers on top of it.
 */
import type {
  ExecOptions,
  ExecutionRecord,
  RawResult,
  Result,
} from "./executions.ts";
import { quoted } from "./executions.ts";

export type YurtStatus = "idle" | "booting" | "running" | "failed";

export type DirEntry = {
  name: string;
  type: "file" | "dir" | "link" | "other";
  size: number;
  mode: number;
};

export type Execution = {
  readonly id: string;
  wait(): Promise<Result>;
  kill(signal?: string): Promise<void>;
};

export type Yurt = {
  readonly status: YurtStatus;
  /** Resolves when the shell is usable; rejects with the boot's error. */
  readonly ready: Promise<void>;
  spawn(cmd: string, opts?: ExecOptions): Promise<Execution>;
  exec(cmd: string, opts?: ExecOptions): Promise<Result>;
  fs: {
    read(path: string): Promise<Uint8Array>;
    write(
      path: string,
      data: Uint8Array | string,
      opts?: { mode?: number; atomic?: boolean },
    ): Promise<void>;
    list(path: string): Promise<DirEntry[]>;
    download(path: string): Promise<void>;
  };
  /** Every execution the registry still holds. */
  list(): Promise<ExecutionRecord[]>;
};

/** What the page hands this module: a way to ask the worker. */
export type YurtTransport = {
  spawn(cmd: string, opts: ExecOptions): Promise<string>;
  wait(id: string): Promise<Result>;
  waitRaw(id: string): Promise<RawResult>;
  kill(id: string, signal?: string): Promise<void>;
  list(): Promise<ExecutionRecord[]>;
};

/** A typed error for a path this API does not carry. */
export class PathError extends Error {}

/** v1 speaks UTF-8 paths only, and says so rather than mangling one. */
export function checkPath(path: string): string {
  if (path === "" || path.includes("\0")) {
    throw new PathError(`path ${JSON.stringify(path)} is not a path`);
  }
  if (!path.startsWith("/")) {
    throw new PathError(`path ${JSON.stringify(path)} is not absolute`);
  }
  return path;
}

/** `find` names the entries NUL-terminated and `stat` types and sizes
 * each on a line of its own, so a name may hold anything but NUL: the
 * pairs are read back as (line, NUL-terminated name). One shell loop, no
 * process per entry (an `xargs -n1 sh -c` form hung now and then). */
export function buildListLine(path: string): string {
  return `find ${quoted(path)} -mindepth 1 -maxdepth 1 -print0 | ` +
    `while IFS= read -r -d '' f; do stat -c '%F|%s|%a' -- "$f" && printf '%s\\0' "$f"; done`;
}

const decoder = new TextDecoder("utf-8", { fatal: true });

export function parseListing(bytes: Uint8Array, dir: string): DirEntry[] {
  const entries: DirEntry[] = [];
  let at = 0;
  while (at < bytes.byteLength) {
    const nl = bytes.indexOf(0x0a, at);
    if (nl < 0) break;
    const meta = decoder.decode(bytes.subarray(at, nl));
    const nul = bytes.indexOf(0, nl + 1);
    if (nul < 0) break;
    let name: string;
    try {
      name = decoder.decode(bytes.subarray(nl + 1, nul));
    } catch {
      throw new PathError(`an entry of ${dir} is not a UTF-8 name`);
    }
    at = nul + 1;
    const [kind, size, mode] = meta.split("|");
    const base = name.startsWith(dir.replace(/\/+$/, "") + "/")
      ? name.slice(dir.replace(/\/+$/, "").length + 1)
      : name;
    entries.push({
      name: base,
      type: kind === "regular file" || kind === "regular empty file"
        ? "file"
        : kind === "directory"
        ? "dir"
        : kind === "symbolic link"
        ? "link"
        : "other",
      size: Number(size),
      mode: parseInt(mode, 8),
    });
  }
  return entries;
}

function failed(result: Result | RawResult, what: string): Error {
  const stderr = typeof result.stderr === "string"
    ? result.stderr
    : new TextDecoder().decode(result.stderr);
  const why = "stillRunning" in result
    ? "timed out"
    : `exit ${result.code ?? result.signal}`;
  return new Error(
    `${what}: ${why}${stderr.trim() ? `: ${stderr.trim()}` : ""}`,
  );
}

export function createYurt(
  transport: YurtTransport,
  status: { current: () => YurtStatus; ready: Promise<void> },
  save: (name: string, bytes: Uint8Array) => void = saveInBrowser,
): Yurt {
  const spawn = async (
    cmd: string,
    opts: ExecOptions = {},
  ): Promise<Execution> => {
    const id = await transport.spawn(cmd, opts);
    return {
      id,
      wait: () => transport.wait(id),
      kill: (signal) => transport.kill(id, signal),
    };
  };
  const exec = async (cmd: string, opts?: ExecOptions) =>
    (await spawn(cmd, opts)).wait();
  const execRaw = async (cmd: string, opts: ExecOptions = {}) => {
    const id = await transport.spawn(cmd, opts);
    return transport.waitRaw(id);
  };
  const fs: Yurt["fs"] = {
    async read(path) {
      checkPath(path);
      const result = await execRaw(`cat -- ${quoted(path)}`, {
        maxOutputBytes: 64 * 1024 * 1024,
      });
      if (!("code" in result) || result.code !== 0) {
        throw failed(result, `read ${path}`);
      }
      if (result.stdoutTruncated) {
        throw new Error(`read ${path}: larger than 64 MiB`);
      }
      return result.stdout;
    },
    async write(path, data, opts = {}) {
      checkPath(path);
      const bytes = typeof data === "string"
        ? new TextEncoder().encode(data)
        : data;
      const mode = opts.mode === undefined
        ? ""
        : ` && chmod ${opts.mode.toString(8)} -- ${quoted(path)}`;
      const line = opts.atomic === false
        ? `cat > ${quoted(path)}${mode}`
        : `t=${quoted(path)}.yurt-tmp.$$ && cat > "$t" && mv -f -- "$t" ${
          quoted(path)
        }${mode}`;
      const result = await exec(line, { stdin: bytes });
      if (!("code" in result) || result.code !== 0) {
        throw failed(result, `write ${path}`);
      }
    },
    async list(path) {
      checkPath(path);
      const result = await execRaw(buildListLine(path));
      if (!("code" in result) || result.code !== 0) {
        throw failed(result, `list ${path}`);
      }
      return parseListing(result.stdout, path);
    },
    async download(path) {
      const bytes = await fs.read(path);
      save(path.split("/").pop() || "file", bytes);
    },
  };
  return {
    get status() {
      return status.current();
    },
    ready: status.ready,
    spawn,
    exec,
    fs,
    list: () => transport.list(),
  };
}

function saveInBrowser(name: string, bytes: Uint8Array): void {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart]));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
