/**
 * What the suspend/resume notebook kernel stages from the playground image:
 * the Python stdlib and /etc, nothing else. The ramfs lives in the kernel's
 * memory and every staged byte is copied on every seal, so the image's other
 * 200 MB (busybox, clang, site-packages, the interpreter itself) stay out;
 * the interpreter arrives as `python3-seal.wasm` instead.
 */
const PYTHON_STDLIB = "/usr/local/lib/python3.14/";
/** Stdlib trees a notebook cell never needs; together most of the stdlib's
 *  bytes, and every one of them would be copied on every seal. */
const PYTHON_STDLIB_SKIPPED = [
  "site-packages/",
  "config-3.14/",
  "idlelib/",
  "tkinter/",
  "turtledemo/",
  "lib2to3/",
  "ensurepip/",
  "pydoc_data/",
  "test/",
  "tests/",
  "__pycache__/",
];
/** Whether an image entry is staged for the guest. */
export function stagedPath(path: string): boolean {
  if (path.startsWith("/etc/")) return true;
  if (!path.startsWith(PYTHON_STDLIB)) return false;
  const rel = path.slice(PYTHON_STDLIB.length);
  return !PYTHON_STDLIB_SKIPPED.some((skipped) =>
    rel.startsWith(skipped) || rel.includes(`/${skipped}`)
  );
}
