// Its own module: restoreSnapshot reads the page's pins once per module.
import { assertEquals, assertRejects } from "@std/assert";
import type { SandboxSealImage } from "@yurt/kernel-host-interface-js";
import { restoreSnapshot } from "../src/boot.ts";
import { sha256Hex } from "../src/integrity.ts";
import { parsePins } from "../src/pins.ts";
import {
  decodeSandboxSnapshot,
  encodeSandboxSnapshot,
  snapshotIdentity,
  SnapshotMismatch,
} from "../src/sandbox_snapshot.ts";

function image(memoryBytes: number): SandboxSealImage {
  return {
    version: 2,
    kernelToken: 1n,
    kernelMemory: new Uint8Array(memoryBytes).fill(5),
    processes: [],
    hostWaits: [],
    monotonicNs: 1n,
    realtimeOffsetNs: 0n,
  };
}

Deno.test("the check before the memory is allocated is told its size", async () => {
  const built = {
    kernelSha256: "ab".repeat(32),
    kernelRev: "r",
    sealVersion: 2,
    bootSetup: 2,
    imageSha256: "cd".repeat(32),
    pythonSealSha256: null,
    pythonSet: null,
  };
  const file = await encodeSandboxSnapshot(image(1024), built);
  const told: number[] = [];
  await decodeSandboxSnapshot(
    file.stream(),
    built,
    undefined,
    (bytes: number) => {
      told.push(bytes);
      return Promise.resolve();
    },
  );
  assertEquals(told, [1024]);
});

Deno.test("a snapshot whose manifest names another memory size than its pin is refused before the memory is allocated", async () => {
  const raw = JSON.parse(
    await Deno.readTextFile(new URL("../artifacts/pins.json", import.meta.url)),
  );
  const built = {
    ...snapshotIdentity(parsePins({ ...raw, snapshot: undefined })),
    pythonSet: null,
  };
  const file = new Uint8Array(
    await (await encodeSandboxSnapshot(image(1024), built)).arrayBuffer(),
  );
  const name = "snapshot/sandbox.seal.zip";
  const pin = {
    releaseRepo: "r",
    release: "t",
    format: 4,
    sha256: await sha256Hex(file),
    size: file.byteLength,
    builtFrom: built,
    // The pin's own record: what a restore allocates.
    memoryBytes: 512,
  };
  const pinsText = JSON.stringify({ ...raw, snapshot: pin });
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("pins.json")) {
      return Promise.resolve(new Response(pinsText));
    }
    if (url.endsWith(".parts.json")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            size: file.byteLength,
            partBytes: file.byteLength,
            parts: ["sandbox.seal.zip.0"],
          }),
        ),
      );
    }
    return Promise.resolve(new Response(file));
  }) as typeof fetch;
  try {
    await assertRejects(
      () =>
        restoreSnapshot(
          {
            isolated: true,
            fetchBytes: () => Promise.reject(new Error("not in this test")),
            show: () => {},
            term: {} as never,
          },
          new Uint8Array(),
          `http://pg/${name}`,
          undefined,
        ),
      SnapshotMismatch,
      "memoryBytes 1024, not the pinned 512",
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});
