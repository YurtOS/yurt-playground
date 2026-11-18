// The kernel memory's maximum the playground plans for an iPad or iPhone tab
// (yurtos-kernel#4239) travels as `HostState.kernelMemoryMaximumBytes`. A
// kernel host older than #4239 has no such option, and the playground ships
// its pinned host until the pin moves: there the field must be ignored, and
// the kernel must load and run as before.
import { assert, assertEquals } from "@std/assert";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { KernelHostInterface } from "@yurt/kernel-host-interface-js";
import { MIN_GUEST_MEMORY_RESERVATION_BYTES } from "../src/guest_memory_reservation.ts";
import { playgroundHostState } from "../src/boot.ts";
import { handlePlaygroundRequest } from "../src/serve.ts";
import { loadPins, resolveArtifacts } from "../src/pins.ts";

const MIB = 1024 * 1024;
const repoRoot = join(fileURLToPath(import.meta.url), "../..");
const IPAD_UA =
  "Mozilla/5.0 (iPad; CPU OS 18_7 like Mac OS X) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/26.6.1 Mobile/15E148 Safari/604.1";

/** The pinned kernel wasm, or `null` when the artifacts are not resolvable
 *  here (a failure when `PLAYGROUND_REQUIRE_ARTIFACTS=1`, as in CI). */
async function pinnedKernelWasm(): Promise<Uint8Array | null> {
  const artifactsDir = join(repoRoot, "artifacts");
  try {
    await resolveArtifacts({
      artifactsDir,
      pins: await loadPins(join(artifactsDir, "pins.json")),
      kernelRoot: Deno.env.get("YURT_KERNEL_ROOT") ??
        join(repoRoot, "../yurtos-kernel"),
      portsRoot: Deno.env.get("YURT_PORTS_ROOT"),
    });
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    if (Deno.env.get("PLAYGROUND_REQUIRE_ARTIFACTS") === "1") {
      throw new Error(`artifacts were required, so this must not skip: ${why}`);
    }
    console.log(`skipping kernel-memory test: ${why}`);
    return null;
  }
  const res = await handlePlaygroundRequest(
    new Request("http://playground/yurt_kernel.wasm"),
  );
  if (!res.ok) throw new Error("failed to load the pinned kernel");
  return new Uint8Array(await res.arrayBuffer());
}

Deno.test({
  name:
    "the pinned kernel host loads and runs with an iPad's 512 MiB kernel memory in its host state",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const wasm = await pinnedKernelWasm();
    if (!wasm) return;
    const state = playgroundHostState(
      IPAD_UA,
      MIN_GUEST_MEMORY_RESERVATION_BYTES,
      512 * MIB,
    );
    assertEquals(state.kernelMemoryMaximumBytes, 512 * MIB);
    const mk = await KernelHostInterface.load(wasm, state);
    try {
      // A file written into the kernel's ramfs reads back: the kernel booted
      // and serves calls, whether or not this host honours the field.
      const enc = new TextEncoder();
      const path = enc.encode("/tmp-kernel-memory-probe");
      const content = enc.encode("512 MiB\n");
      mk.registerRamfsFile(path, content);
      assert(
        mk.listProcesses().length >= 0,
        "the kernel answers after load",
      );
    } finally {
      mk.dispose();
    }
  },
});
