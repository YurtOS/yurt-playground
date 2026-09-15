import { assertEquals } from "@std/assert";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  handlePlaygroundRequest,
  resolvePlaygroundPath,
} from "../src/serve.ts";
import { kernelImportMap, resolveKernelRoot } from "../scripts/serve.ts";

const isolation = {
  coop: "same-origin",
  coep: "require-corp",
  corp: "same-origin",
};

Deno.test("relative YURT_KERNEL_ROOT resolves from the repository root", () => {
  assertEquals(
    resolveKernelRoot(
      "../yurtos-kernel",
      "/workspace/yurt-playground",
    ),
    "/workspace/yurtos-kernel",
  );
});

Deno.test("the bundle import map resolves a relative kernel root", () => {
  // CI passes YURT_KERNEL_ROOT=../yurtos-kernel. A relative specifier in
  // public/import-map.json resolves against public/, not the repo root, so it
  // has to be absolute by the time it is written.
  const { imports } = kernelImportMap("../yurtos-kernel");
  for (const key of ["@yurt/kernel-host-interface-js", "@yurt/tar-image"]) {
    const specifier = imports[key];
    assertEquals(
      specifier.startsWith(resolveKernelRoot("../yurtos-kernel")),
      true,
      `${key} is not an absolute kernel path: ${specifier}`,
    );
  }
});

Deno.test("playground HTTP responses carry COOP/COEP", async () => {
  const res = await handlePlaygroundRequest(new Request("http://playground/"));
  assertEquals(res.headers.get("Cross-Origin-Opener-Policy"), isolation.coop);
  assertEquals(
    res.headers.get("Cross-Origin-Embedder-Policy"),
    isolation.coep,
  );
  assertEquals(
    res.headers.get("Cross-Origin-Resource-Policy"),
    isolation.corp,
  );
  // The workspace page: the terminal, and the one action that boots it.
  const html = await res.text();
  assertEquals(html.includes('id="term"'), true);
  assertEquals(html.includes('data-testid="start-sandbox"'), true);
});

Deno.test("path resolver rejects a .. segment", () => {
  assertEquals(resolvePlaygroundPath("/foo/../index.html"), null);
  assertEquals(resolvePlaygroundPath("/../../pins.json"), null);
});

Deno.test("handler rejects a malformed percent-encoding", async () => {
  const res = await handlePlaygroundRequest(
    new Request("http://playground/%zz"),
  );
  assertEquals(res.status, 404);
  assertEquals(res.headers.get("Cross-Origin-Opener-Policy"), isolation.coop);
  await res.body?.cancel();
});

Deno.test("worker bootstrap is served as a JS module", async () => {
  const publicDir = join(dirname(fileURLToPath(import.meta.url)), "../public");
  const workerPath = join(publicDir, "worker_bootstrap.js");
  await Deno.writeTextFile(workerPath, "export {};\n");
  try {
    const res = await handlePlaygroundRequest(
      new Request("http://playground/worker_bootstrap.js"),
    );
    assertEquals(res.status, 200);
    assertEquals(
      res.headers.get("content-type"),
      "text/javascript; charset=utf-8",
    );
    await res.body?.cancel();
  } finally {
    await Deno.remove(workerPath);
  }
});

Deno.test("handler 404s also carry isolation headers", async () => {
  const res = await handlePlaygroundRequest(
    new Request("http://playground/nope"),
  );
  assertEquals(res.status, 404);
  assertEquals(res.headers.get("Cross-Origin-Opener-Policy"), isolation.coop);
  assertEquals(
    res.headers.get("Cross-Origin-Embedder-Policy"),
    isolation.coep,
  );
  await res.body?.cancel();
});
