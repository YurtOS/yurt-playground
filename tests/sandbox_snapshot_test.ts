import { assertEquals, assertRejects } from "@std/assert";
import type { SandboxSealImage } from "@yurt/kernel-host-interface-js";
import {
  decodeSandboxSnapshot,
  encodeSandboxSnapshot,
} from "../src/sandbox_snapshot.ts";

function image(memoryBytes: number): SandboxSealImage {
  const kernelMemory = new Uint8Array(memoryBytes);
  for (let i = 0; i < memoryBytes; i += 4093) kernelMemory[i] = i % 251;
  return {
    version: 1,
    kernelToken: 0xfedcba9876543210n,
    kernelMemory,
    processes: [],
    hostWaits: [{
      parkKey: 1n << 40n,
      ticket: 7n,
      sourceKind: 2,
      param: 0n,
      pid: 1,
      tid: 1,
      remainingNs: 123n,
    }],
    monotonicNs: 9_000_000_000n,
    realtimeOffsetNs: -5n,
    executor: {
      contexts: [{ handle: 3n, descriptor: {} as never }],
      freeScratch: [{ start: 64, length: 128 }],
    },
  };
}

Deno.test("a sandbox snapshot round-trips its seal image and kernel hash", async () => {
  const sealed = image(3 * 1024 * 1024 + 5);
  const file = await encodeSandboxSnapshot(sealed, "ab".repeat(32));
  const { image: back, kernelSha256 } = await decodeSandboxSnapshot(
    file.stream(),
  );
  assertEquals(kernelSha256, "ab".repeat(32));
  assertEquals(back, sealed);
});

Deno.test("a seal with a process in it is no sandbox snapshot", async () => {
  const sealed = { ...image(16), processes: [{} as never] };
  await assertRejects(
    () => encodeSandboxSnapshot(sealed, "00"),
    Error,
    "holds no process",
  );
});

Deno.test("a truncated sandbox snapshot is refused", async () => {
  const file = await encodeSandboxSnapshot(image(1 << 20), "00");
  const raw = new Uint8Array(
    await new Response(
      file.stream().pipeThrough(new DecompressionStream("gzip")),
    ).arrayBuffer(),
  );
  const cut = await new Response(
    new Blob([raw.subarray(0, raw.byteLength - 10)]).stream().pipeThrough(
      new CompressionStream("gzip"),
    ),
  ).blob();
  await assertRejects(
    () => decodeSandboxSnapshot(cut.stream()),
    Error,
    "truncated",
  );
});
