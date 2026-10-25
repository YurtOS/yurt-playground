/** Files from this device into the sandbox: the "Upload" control and a drop
 * on the terminal. Each file is written with `yurt.fs.write` into the
 * login home under its own name, so `ls` shows it at the prompt. */

/** Where uploads land: the login home, as `cd` with no argument. */
export const UPLOAD_DIR = "/home/user";

/** The path an uploaded file is written to. Only the name's last component
 * is kept (a drop can carry directories, either separator), and a name that
 * cannot be a file in the home is refused. */
export function uploadTarget(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  if (base === "" || base === "." || base === ".." || base.includes("\0")) {
    throw new Error(`cannot upload ${JSON.stringify(name)}: not a file name`);
  }
  return `${UPLOAD_DIR}/${base}`;
}

/** The largest file one upload takes: the cap `fs.read` and the desktop
 * app's file route already use (FS_CONTENT_LIMIT). In the tab the bytes are
 * held several times over on their way into a memory-only filesystem, so a
 * larger file could take the sandbox down with everything in it. */
export const UPLOAD_MAX_BYTES = 64 * 1024 * 1024;

const WASM_MAGIC = [0x00, 0x61, 0x73, 0x6d];

/** The mode an uploaded file gets: a wasm module (a program built for the
 * sandbox, a Go binary for one) or a `#!` script runs as `./name` at once;
 * anything else is a plain file. */
export function uploadMode(bytes: Uint8Array): number {
  const wasm = WASM_MAGIC.every((byte, i) => bytes[i] === byte);
  const script = bytes[0] === 0x23 && bytes[1] === 0x21;
  return wasm || script ? 0o755 : 0o644;
}

type Writer = {
  fs: {
    write(
      path: string,
      data: Uint8Array,
      opts?: { mode?: number; atomic?: boolean },
    ): Promise<void>;
  };
};

/** Write `files` into the home one at a time, reporting each through
 * `progress`. Returns the paths written; the first failure is thrown with
 * the file's name, and the files before it stay written. A name that cannot
 * be a file or a file over UPLOAD_MAX_BYTES refuses the whole upload before
 * anything is written. */
export async function uploadFiles(
  yurt: Writer,
  files: Iterable<File>,
  progress: (message: string) => void,
): Promise<string[]> {
  const queue = Array.from(files, (file) => {
    if (file.size > UPLOAD_MAX_BYTES) {
      throw new Error(
        `cannot upload ${file.name}: ${file.name} is larger than ${
          UPLOAD_MAX_BYTES / (1024 * 1024)
        } MiB`,
      );
    }
    return { file, path: uploadTarget(file.name) };
  });
  const written: string[] = [];
  for (const { file, path } of queue) {
    progress(`uploading ${file.name}`);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      await yurt.fs.write(path, bytes, { mode: uploadMode(bytes) });
    } catch (error) {
      throw new Error(
        `upload ${file.name}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    written.push(path);
  }
  return written;
}
