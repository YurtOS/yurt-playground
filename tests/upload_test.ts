import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  UPLOAD_DIR,
  UPLOAD_MAX_BYTES,
  uploadFiles,
  uploadMode,
  uploadTarget,
} from "../src/upload.ts";

Deno.test("an uploaded file lands in the login home under its own name", () => {
  assertEquals(uploadTarget("hello.go"), `${UPLOAD_DIR}/hello.go`);
  assertEquals(uploadTarget("my notes.txt"), `${UPLOAD_DIR}/my notes.txt`);
});

Deno.test("a name that is a path keeps only its last component", () => {
  // Browsers hand over a bare name, but a drop from some file managers
  // and a webkitRelativePath carry directories.
  assertEquals(uploadTarget("dir/sub/a.txt"), `${UPLOAD_DIR}/a.txt`);
  assertEquals(uploadTarget("C:\\Users\\me\\a.txt"), `${UPLOAD_DIR}/a.txt`);
});

Deno.test("a name that cannot be a file in the home is refused", () => {
  for (const name of ["", ".", "..", "a/..", "dir/", "x\0y"]) {
    assertThrows(() => uploadTarget(name), Error, "cannot upload");
  }
});

Deno.test("a wasm module or a #! script is executable, anything else is not", () => {
  const wasm = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0]);
  assertEquals(uploadMode(wasm), 0o755);
  assertEquals(
    uploadMode(new TextEncoder().encode("#!/bin/sh\necho hi\n")),
    0o755,
  );
  assertEquals(uploadMode(new TextEncoder().encode("package main\n")), 0o644);
  assertEquals(uploadMode(new Uint8Array([0x00, 0x61])), 0o644);
  assertEquals(uploadMode(new Uint8Array()), 0o644);
});

type Write = { path: string; bytes: number; mode?: number };

function recorder(failOn?: string) {
  const writes: Write[] = [];
  return {
    writes,
    yurt: {
      fs: {
        write(path: string, data: Uint8Array, opts?: { mode?: number }) {
          if (path.endsWith(`/${failOn}`)) {
            return Promise.reject(new Error("Is a directory"));
          }
          writes.push({ path, bytes: data.length, mode: opts?.mode });
          return Promise.resolve();
        },
      },
    },
  };
}

Deno.test("uploadFiles writes each file in order and reports its progress", async () => {
  const { writes, yurt } = recorder();
  const progress: string[] = [];
  const written = await uploadFiles(
    yurt,
    [new File(["#!/bin/sh\n"], "run.sh"), new File(["x"], "a.txt")],
    (message) => progress.push(message),
  );
  assertEquals(written, [`${UPLOAD_DIR}/run.sh`, `${UPLOAD_DIR}/a.txt`]);
  assertEquals(writes, [
    { path: `${UPLOAD_DIR}/run.sh`, bytes: 10, mode: 0o755 },
    { path: `${UPLOAD_DIR}/a.txt`, bytes: 1, mode: 0o644 },
  ]);
  assertEquals(progress, ["uploading run.sh", "uploading a.txt"]);
});

Deno.test("a failed write names the file and keeps the ones before it", async () => {
  const { writes, yurt } = recorder("b.txt");
  await assertRejects(
    () =>
      uploadFiles(
        yurt,
        [new File(["a"], "a.txt"), new File(["b"], "b.txt")],
        () => {},
      ),
    Error,
    "upload b.txt: Is a directory",
  );
  assertEquals(writes.map((w) => w.path), [`${UPLOAD_DIR}/a.txt`]);
});

Deno.test("a file that cannot be read is reported by name", async () => {
  const { yurt } = recorder();
  const unreadable = new File(["x"], "gone.txt");
  unreadable.arrayBuffer = () =>
    Promise.reject(new DOMException("could not be found", "NotFoundError"));
  await assertRejects(
    () => uploadFiles(yurt, [unreadable], () => {}),
    Error,
    "upload gone.txt: could not be found",
  );
});

Deno.test("a file over the size limit is refused before anything is written", async () => {
  const { writes, yurt } = recorder();
  const big = new File([""], "big.iso");
  Object.defineProperty(big, "size", { value: UPLOAD_MAX_BYTES + 1 });
  await assertRejects(
    () => uploadFiles(yurt, [new File(["a"], "a.txt"), big], () => {}),
    Error,
    "big.iso is larger than 64 MiB",
  );
  assertEquals(writes, []);
});
