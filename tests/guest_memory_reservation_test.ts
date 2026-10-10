import { assert, assertEquals } from "@std/assert";
import {
  engineCapsSharedMemoryReservations,
  GUEST_MEMORY_RESERVATION_BYTES,
  playgroundHostState,
} from "../src/boot.ts";

const MIB = 1024 * 1024;

const SAFARI_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/26.6.2 Safari/605.1.15";
const IOS_CHROME_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) " +
  "AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/140.0 Mobile/15E148 " +
  "Safari/604.1";
const CHROME_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const FIREFOX_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14.0; rv:140.0) " +
  "Gecko/20100101 Firefox/140.0";

Deno.test("on JavaScriptCore each guest process reserves a quarter GiB, not the whole sandbox budget", () => {
  // yurtos-kernel#2996: Safari holds about 32 GiB of shared wasm memory
  // reservations per tab, and every process used to reserve the 1 GiB
  // sandbox budget, so a burst of a few dozen execs ran it out.
  for (const ua of [SAFARI_UA, IOS_CHROME_UA]) {
    assert(engineCapsSharedMemoryReservations(ua), ua);
    assertEquals(
      playgroundHostState(ua).guestMemoryReservationBytes,
      GUEST_MEMORY_RESERVATION_BYTES,
    );
  }
  assert(32 * 1024 / (GUEST_MEMORY_RESERVATION_BYTES / MIB) >= 100);
  // Measured peaks: ipykernel 81 MiB, a 2000x2000 NumPy matmul 98 MiB.
  assert(GUEST_MEMORY_RESERVATION_BYTES >= 2 * 98 * MIB);
});

Deno.test("on V8 and SpiderMonkey each guest process keeps the whole sandbox budget", () => {
  // The reservation is a WebKit workaround; elsewhere it would only cap a
  // process (a 1.1 GB NumPy array, a large clang TU) below the budget.
  for (const ua of [CHROME_UA, FIREFOX_UA, undefined]) {
    assert(!engineCapsSharedMemoryReservations(ua), String(ua));
    assertEquals(
      playgroundHostState(ua).guestMemoryReservationBytes,
      undefined,
    );
  }
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

Deno.test("every in-browser kernel load and restore goes through the playground's host state", () => {
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
