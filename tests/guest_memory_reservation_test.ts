import { assert, assertEquals } from "@std/assert";
import {
  GUEST_MEMORY_RESERVATION_BYTES,
  playgroundHostState,
} from "../src/boot.ts";

const MIB = 1024 * 1024;

Deno.test("each guest process reserves a quarter GiB, not the whole sandbox budget", () => {
  // yurtos-kernel#2996: Safari holds about 32 GiB of shared wasm memory
  // reservations per tab, and every process used to reserve the 1 GiB
  // sandbox budget, so a burst of a few dozen execs ran it out.
  assertEquals(
    playgroundHostState().guestMemoryReservationBytes,
    GUEST_MEMORY_RESERVATION_BYTES,
  );
  assert(32 * 1024 / (GUEST_MEMORY_RESERVATION_BYTES / MIB) >= 100);
  // Measured peaks: ipykernel 81 MiB, a 2000x2000 NumPy matmul 98 MiB.
  assert(GUEST_MEMORY_RESERVATION_BYTES >= 2 * 98 * MIB);
});

const KERNEL_BUILD = /KernelHostInterface\s*\.\s*(load|restore)\s*\(/g;

/** Every `.ts` file under `src/`, recursively, as `[path, text]`. */
function sourceFiles(
  dir = new URL("../src/", import.meta.url),
): [string, string][] {
  const files: [string, string][] = [];
  for (const entry of Deno.readDirSync(dir)) {
    const url = new URL(entry.name + (entry.isDirectory ? "/" : ""), dir);
    if (entry.isDirectory) files.push(...sourceFiles(url));
    else if (entry.isFile && entry.name.endsWith(".ts")) {
      files.push([url.pathname, Deno.readTextFileSync(url)]);
    }
  }
  return files;
}

Deno.test("every in-browser kernel load and restore reserves the playground's quarter GiB", () => {
  // The kernel applies the reservation wherever it builds a guest memory,
  // restore included: a worker that loads or restores with the default
  // state puts its guests back on the whole sandbox budget. So only
  // loadPlaygroundKernel and restorePlaygroundKernel in boot.ts may build
  // a kernel, and each passes playgroundHostState().
  const outside: string[] = [];
  let boot = "";
  for (const [path, text] of sourceFiles()) {
    if (path.endsWith("/src/boot.ts")) boot = text;
    else if (text.match(KERNEL_BUILD)) outside.push(path);
  }
  assertEquals(
    outside,
    [],
    "build the kernel with loadPlaygroundKernel or restorePlaygroundKernel",
  );
  assertEquals([...boot.matchAll(KERNEL_BUILD)].map((m) => m[1]), [
    "load",
    "restore",
  ]);
  assert(
    boot.includes("KernelHostInterface.load(kernel, playgroundHostState())"),
  );
  assert(
    boot.includes(
      "KernelHostInterface.restore(kernel, image, playgroundHostState())",
    ),
  );
});
