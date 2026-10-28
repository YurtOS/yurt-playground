import { assertEquals, assertRejects } from "@std/assert";
import type { SandboxSealImage } from "@yurt/kernel-host-interface-js";
import { imagePartsManifest } from "../src/image_parts.ts";
import { sha256Hex } from "../src/integrity.ts";
import {
  checkSandboxSnapshot,
  decodeSandboxSnapshot,
  encodeSandboxSnapshot,
  fetchVerifiedSnapshot,
  type SnapshotIdentity,
  snapshotIdentity,
  SnapshotMismatch,
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

const BUILT: SnapshotIdentity = {
  kernelSha256: "ab".repeat(32),
  imageSha256: "cd".repeat(32),
  pythonSealSha256: "ef".repeat(32),
};

/** A gzipped snapshot file made of `header` as written, with `memory`
 * after it: for headers the encoder does not write. */
async function rawSnapshot(
  header: Record<string, unknown>,
  memory = new Uint8Array(0),
): Promise<Blob> {
  const json = new TextEncoder().encode(JSON.stringify(header));
  const length = new Uint8Array(4);
  new DataView(length.buffer).setUint32(0, json.byteLength, true);
  return await new Response(
    new Blob([length, json, memory]).stream().pipeThrough(
      new CompressionStream("gzip"),
    ),
  ).blob();
}

Deno.test("a sandbox snapshot round-trips its seal image under the build it was made from", async () => {
  const sealed = image(3 * 1024 * 1024 + 5);
  const file = await encodeSandboxSnapshot(sealed, BUILT);
  assertEquals(await decodeSandboxSnapshot(file.stream(), BUILT), sealed);
});

Deno.test("a sandbox snapshot from another kernel, image or Python set is refused, by name", async () => {
  const file = await encodeSandboxSnapshot(image(4096), BUILT);
  for (
    const key of [
      "kernelSha256",
      "imageSha256",
      "pythonSealSha256",
    ] as const
  ) {
    const expected = { ...BUILT, [key]: "00".repeat(32) };
    const error = await assertRejects(
      () => decodeSandboxSnapshot(file.stream(), expected),
      SnapshotMismatch,
      `${key} ${BUILT[key]}, not ${"00".repeat(32)}`,
    );
    assertEquals(error.message.split(";").length, 1, "only what differs");
    await assertRejects(
      () => checkSandboxSnapshot(file.stream(), expected),
      SnapshotMismatch,
      key,
    );
  }
  await checkSandboxSnapshot(file.stream(), BUILT);
});

Deno.test("a sandbox snapshot that does not say what it was built from is refused", async () => {
  // The first format: the kernel's hash alone.
  const file = await rawSnapshot({
    kernelSha256: BUILT.kernelSha256,
    memoryBytes: 16,
  }, new Uint8Array(16));
  await assertRejects(
    () => decodeSandboxSnapshot(file.stream(), BUILT),
    SnapshotMismatch,
    "does not say what it was built from",
  );
});

Deno.test("a mismatched sandbox snapshot is refused before its memory is allocated", async () => {
  // 4 PiB: allocating it first would throw a RangeError, not the mismatch.
  const file = await rawSnapshot({
    format: 2,
    builtFrom: { ...BUILT, kernelSha256: "00".repeat(32) },
    memoryBytes: 2 ** 52,
  });
  await assertRejects(
    () => decodeSandboxSnapshot(file.stream(), BUILT),
    SnapshotMismatch,
    "kernelSha256",
  );
});

Deno.test("a truncated sandbox snapshot is refused", async () => {
  const file = await encodeSandboxSnapshot(image(1 << 20), BUILT);
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
    () => decodeSandboxSnapshot(cut.stream(), BUILT),
    Error,
    "truncated",
  );
});

Deno.test("a seal with a process in it is no sandbox snapshot", async () => {
  const sealed = { ...image(16), processes: [{} as never] };
  await assertRejects(
    () => encodeSandboxSnapshot(sealed, BUILT),
    Error,
    "holds no process",
  );
});

Deno.test("a snapshot's identity is the pinned kernel, the image the browser boots, and the Python set", () => {
  const pin = (sha256: string) => ({
    repo: "r",
    rev: "v",
    build: "b",
    path: "p",
    sha256,
  });
  assertEquals(
    snapshotIdentity({
      kernelWasm: pin("k"),
      image: pin("full"),
      browserImage: pin("slim"),
      pythonSeal: { sha256: "py" },
    }),
    { kernelSha256: "k", imageSha256: "slim", pythonSealSha256: "py" },
  );
  assertEquals(
    snapshotIdentity({ kernelWasm: pin("k"), image: pin("full") }),
    { kernelSha256: "k", imageSha256: "full", pythonSealSha256: null },
  );
});

/** A site serving `file` in parts at `path`, with `sha256` beside it
 * (none when undefined). */
function site(
  path: string,
  file: Uint8Array<ArrayBuffer>,
  sha256: string | undefined,
): typeof fetch {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const manifest = imagePartsManifest(path, file.byteLength);
  return (input) => {
    const url = new URL(String(input), "http://pg/");
    const name = url.pathname.slice(1);
    if (name === `${path}.sha256` && sha256 !== undefined) {
      return Promise.resolve(new Response(`${sha256}\n`));
    }
    if (name === `${path}.parts.json`) {
      return Promise.resolve(new Response(JSON.stringify(manifest)));
    }
    if (name === `${path.slice(0, -base.length)}${base}.0`) {
      return Promise.resolve(new Response(file));
    }
    return Promise.resolve(new Response(null, { status: 404 }));
  };
}

Deno.test("the downloaded snapshot is checked against the sha256 published beside it", async () => {
  const sealed = image(1 << 16);
  const file = new Uint8Array(
    await (await encodeSandboxSnapshot(sealed, BUILT)).arrayBuffer(),
  );
  const path = "http://pg/snapshot/sandbox.seal.gz";
  const name = "snapshot/sandbox.seal.gz";
  const good = await sha256Hex(file);
  assertEquals(
    await decodeSandboxSnapshot(
      await fetchVerifiedSnapshot(path, site(name, file, good)),
      BUILT,
    ),
    sealed,
  );
  const damaged = file.slice();
  damaged[damaged.byteLength - 20] ^= 0xff;
  await assertRejects(
    () => fetchVerifiedSnapshot(path, site(name, damaged, good)),
    Error,
    "sha256 mismatch",
  );
  await assertRejects(
    () => fetchVerifiedSnapshot(path, site(name, file, undefined)),
    Error,
    "sandbox.seal.gz.sha256 failed: 404",
  );
});
