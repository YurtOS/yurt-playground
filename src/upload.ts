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
 * the file's name, and the files before it stay written. */
export async function uploadFiles(
  yurt: Writer,
  files: Iterable<File>,
  progress: (message: string) => void,
): Promise<string[]> {
  const written: string[] = [];
  for (const file of files) {
    const path = uploadTarget(file.name);
    progress(`uploading ${file.name}`);
    const bytes = new Uint8Array(await file.arrayBuffer());
    try {
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
