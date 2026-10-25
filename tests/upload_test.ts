import { assertEquals, assertThrows } from "@std/assert";
import { UPLOAD_DIR, uploadMode, uploadTarget } from "../src/upload.ts";

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
