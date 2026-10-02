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
    /** Save `dir` (the login home by default) as a gzipped tar, made by a
     * process of its own: it needs nothing from the user's shell, so it
     * works while a foreground command spins (#81). */
    export(dir?: string): Promise<void>;
  };
  /** Every execution the registry still holds. */
  list(): Promise<ExecutionRecord[]>;
};

/** What the page hands this module: a way to ask the worker (or, on the
 * desktop, the launcher). A transport with `files` moves file bytes its
 * own way (the launcher's `/api/fs/*`, binary on the wire); without it,
 * `fs` is made of commands. */
export type YurtTransport = {
  spawn(cmd: string, opts: ExecOptions): Promise<string>;
  wait(id: string): Promise<Result>;
  waitRaw(id: string): Promise<RawResult>;
  kill(id: string, signal?: string): Promise<void>;
  list(): Promise<ExecutionRecord[]>;
  files?: FilesTransport;
};

export type FilesTransport = {
  read(path: string): Promise<Uint8Array>;
  write(
    path: string,
    bytes: Uint8Array,
    opts: { mode?: number; atomic?: boolean },
  ): Promise<void>;
  list(path: string): Promise<DirEntry[]>;
};

/** A typed error for a path this API does not carry. */
export class PathError extends Error {}

/** The largest archive `fs.export` saves: a home, not a command's output. */
export const EXPORT_MAX_BYTES = 256 * 1024 * 1024;

/** A gzipped tar of `base` under `parent`, streamed to stdout. Python's
 * tarfile rather than BusyBox tar: the image's BusyBox is built without
 * tar's create side (`tar -c` is "unrecognized option"), and CPython is
 * always there. Paths reach Python as command-line arguments, quoted for
 * the shell like every other path this API passes. */
export function buildExportLine(parent: string, base: string): string {
  const program =
    "import sys,tarfile;t=tarfile.open(fileobj=sys.stdout.buffer,mode='w|gz');" +
    "t.add(sys.argv[1],arcname=sys.argv[2]);t.close()";
  return `cd ${quoted(parent)} && python3 -c ${quoted(program)} ${
    quoted(base)
  } ${quoted(base)}`;
}

/** The directory to archive as its parent and its name; `/` has no name
 * to tar under and is refused. */
export function splitExportDir(dir: string): { parent: string; base: string } {
  checkPath(dir);
  const trimmed = dir.replace(/\/+$/, "");
  const at = trimmed.lastIndexOf("/");
  const base = trimmed.slice(at + 1);
  if (base === "" || base === "." || base === "..") {
    throw new PathError(
      `path ${JSON.stringify(dir)} is not a directory to export`,
    );
  }
  return { parent: trimmed.slice(0, at) || "/", base };
}

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

function failed(
  result: Result | RawResult,
  what: string,
  clean: (stderr: string) => string = (stderr) => stderr,
): Error {
  const stderr = clean(
    typeof result.stderr === "string"
      ? result.stderr
      : new TextDecoder().decode(result.stderr),
  );
  const why = "stillRunning" in result
    ? "timed out"
    : `exit ${result.code ?? result.signal}`;
  return new Error(
    `${what}: ${why}${stderr.trim() ? `: ${stderr.trim()}` : ""}`,
  );
}

/** The atomic write's temporary file is the written file's path + this +
 * the shell's pid. */
const TEMP_SUFFIX = ".yurt-tmp.";

/** A failed atomic write ends its stderr with a line of this and the
 * temporary file's path, so hideAtomicTemp knows the exact name. */
const TEMP_MARK = "yurt-atomic-temp=";

/** How many symlinks a write follows at `path` before it gives up, as
 * Linux's open(2) does (MAXSYMLINKS). */
const SYMLINK_LIMIT = 40;

/**
 * Shell lines that set `d` to the file a write to `path` opens: `path`,
 * or, while `d` is a symlink, the file it names, a relative target taken
 * from the link's own directory. More than SYMLINK_LIMIT links is a loop:
 * "<path>: Symbolic link loop" and exit 1, as the guest's `cat >` says.
 * The directories on the way are left to the kernel. Not `readlink -f`:
 * macOS's refuses a dangling link. `-n` and the `x` keep a target's
 * trailing newlines, which `$(...)` would strip; `-n` because macOS's
 * readlink adds no newline of its own after a target that ends in one.
 */
function resolveLinkLines(dest: string): string {
  return `d=${dest}
n=0
while [ -L "$d" ]; do
  n=$((n + 1))
  if [ $n -gt ${SYMLINK_LIMIT} ]; then
    printf '%s: Symbolic link loop\\n' ${dest} >&2
    exit 1
  fi
  l=$(readlink -n -- "$d" && echo x) || exit
  l=\${l%x}
  case $l in
    /*) d=$l ;;
    *) d=\${d%/*}/$l ;;
  esac
done`;
}

/**
 * The shell line for a non-atomic `fs.write`: `cat >` opens `path`, a
 * symlink included, as open(2) does. `mode` gives the `&& chmod ...`
 * suffix (or "") for the shell word naming the file; with one, the link
 * is resolved first (resolveLinkLines) and the mode goes on its target,
 * since the guest's chmod of a symlink changes the link's own mode
 * (yurtos-kernel#3038).
 */
export function plainWriteLine(
  path: string,
  mode: (file: string) => string,
): string {
  const dest = quoted(path);
  const suffix = mode('"$d"');
  return suffix === ""
    ? `cat > ${dest}`
    : `${resolveLinkLines(dest)}\ncat > ${dest}${suffix}`;
}

/**
 * The shell line for an atomic `fs.write`: stdin goes to a temporary file
 * beside the file written, which then replaces it. `mode` gives the
 * `&& chmod ...` suffix (or "") for the shell word naming that file; it
 * stays outside the `if`, so it runs only once the file is in place. A
 * failed `cat` or `mv` removes the temporary file, names it after
 * TEMP_MARK, and exits with the failing command's status: the error names
 * the file, not its temporary name (hideAtomicTemp), so a partial file
 * left behind would go unseen. The guest shell, BusyBox ash, keeps the
 * condition's status in `$?` at the start of the `else` branch, as POSIX
 * requires.
 *
 * A symlink at `path` is written through, as open(O_WRONLY|O_TRUNC|
 * O_CREAT) does (#166): `mv` renames onto the final component, so the
 * line first follows the link chain (resolveLinkLines) and writes the
 * file it names. The link stays a link. A dangling link creates its
 * target; a link to a directory is refused like the directory. The mode
 * goes on the resolved file too.
 *
 * A directory at `path` is refused: `mv` would move the temporary file
 * into it and succeed (#163). The common case is caught before anything
 * is written. A directory that appears while stdin is still streaming is
 * caught after the `mv`, by the temporary file's name inside it, which is
 * removed. Either way the message says "Is a directory", as the
 * non-atomic `cat >` does, so the desktop API answers 400 NotAFile for
 * both. Not BusyBox's `mv -T`: its refusal reads "is a directory", and
 * macOS mv has no `-T`.
 */
export function atomicWriteLine(
  path: string,
  mode: (file: string) => string,
): string {
  const dest = quoted(path);
  const refuse = `printf '%s: Is a directory\\n' ${dest} >&2`;
  return `if [ -d ${dest} ]; then
  ${refuse}
  exit 1
fi
${resolveLinkLines(dest)}
t=$d${TEMP_SUFFIX}$$
if cat > "$t" && mv -f -- "$t" "$d"; then
  # Where \`mv\` put the temporary file if "$d" became a directory.
  i=$d/\${d##*/}${TEMP_SUFFIX}$$
  if [ -d "$d" ] && [ -e "$i" ]; then
    rm -f -- "$i"
    ${refuse}
    exit 1
  fi
else
  s=$?
  rm -f -- "$t"
  printf '\\n%s%s' '${TEMP_MARK}' "$t" >&2
  exit $s
fi${mode('"$d"')}`;
}

/**
 * The temporary file is this module's detail: a failed write's error names
 * the file written (yurt-sandbox#301), the path the caller asked for or,
 * through a symlink, its target. `stderr` is the write line's; when it
 * ends with the TEMP_MARK line, that line goes, and each copy of the
 * temporary path it names becomes the file's path. Nothing else changes,
 * so a file whose own name holds TEMP_SUFFIX keeps it.
 */
export function hideAtomicTemp(stderr: string): string {
  const at = stderr.lastIndexOf(`\n${TEMP_MARK}`);
  if (at < 0) return stderr;
  const temp = stderr.slice(at + 1 + TEMP_MARK.length);
  const rest = stderr.slice(0, at);
  const cut = temp.lastIndexOf(TEMP_SUFFIX);
  return cut < 0 ? rest : rest.split(temp).join(temp.slice(0, cut));
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
      const direct = transport.files;
      if (direct !== undefined) return direct.read(path);
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
      const direct = transport.files;
      if (direct !== undefined) return direct.write(path, bytes, opts);
      const mode = (file: string) =>
        opts.mode === undefined
          ? ""
          : ` && chmod ${opts.mode.toString(8)} -- ${file}`;
      const line = opts.atomic === false
        ? plainWriteLine(path, mode)
        : atomicWriteLine(path, mode);
      const result = await exec(line, { stdin: bytes });
      if (!("code" in result) || result.code !== 0) {
        throw failed(result, `write ${path}`, hideAtomicTemp);
      }
    },
    async list(path) {
      checkPath(path);
      const direct = transport.files;
      if (direct !== undefined) return direct.list(path);
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
    async export(dir = "/home/user") {
      const { parent, base } = splitExportDir(dir);
      const result = await execRaw(buildExportLine(parent, base), {
        maxOutputBytes: EXPORT_MAX_BYTES,
      });
      if (!("code" in result) || result.code !== 0) {
        throw failed(result, `export ${dir}`);
      }
      if (result.stdoutTruncated) {
        throw new Error(
          `export ${dir}: the archive is larger than ${EXPORT_MAX_BYTES} bytes`,
        );
      }
      save(`${base}.tgz`, result.stdout);
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
