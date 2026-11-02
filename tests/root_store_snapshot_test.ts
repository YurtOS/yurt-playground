// A snapshot of a sandbox whose root is a YurtFS store (format 4,
// src/root_store.ts), against a fake of the kernel host's root store API:
// the kernel side does not exist yet (yurtos-kernel#4089 Task 5.4b, Slice 7).
import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  KernelHostInterface,
  type SandboxSealImage,
} from "@yurt/kernel-host-interface-js";
import { restoreSnapshot } from "../src/boot.ts";
import { sha256Hex } from "../src/integrity.ts";
import {
  parsePins,
  parseSnapshotPin,
  PinResolutionError,
} from "../src/pins.ts";
import {
  type PageSeal,
  type RootStoreApi,
  rootStoreOf,
  type SealedStore,
  sealWithStore,
  type StoreFileName,
  type StoreIdentity,
  type StoreRestoreTarget,
} from "../src/root_store.ts";
import {
  BOOT_SETUP,
  type BuiltFrom,
  decodeSandboxSnapshot,
  encodeSandboxSnapshot,
  FORMAT,
  pinnedSnapshot,
  snapshotHeaderFacts,
  snapshotIdentity,
  SnapshotMismatch,
  type SnapshotPin,
  STORE_FORMAT,
} from "../src/sandbox_snapshot.ts";

const BUILT: BuiltFrom = {
  kernelSha256: "ab".repeat(32),
  kernelRev: "3d32068f59dcbbffd1aa7a9482e6b5e6f75472b1",
  sealVersion: 1,
  bootSetup: BOOT_SETUP,
  imageSha256: "cd".repeat(32),
  pythonSealSha256: "ef".repeat(32),
  pythonSet: null,
};

const IDENTITY: StoreIdentity = {
  lineage: "11".repeat(16),
  sequence: "42",
  hash: "22".repeat(32),
};
const OTHER: StoreIdentity = { ...IDENTITY, sequence: "43" };
const LOWER = { bytes: 10_240, sha256: "33".repeat(32) };

function bytes(length: number, seed: number): Uint8Array {
  return Uint8Array.from({ length }, (_, i) => (i * 31 + seed) % 251);
}

function memory(length: number): SandboxSealImage {
  return {
    version: 1,
    kernelToken: 0x1234n,
    kernelMemory: bytes(length, 7),
    processes: [],
    hostWaits: [],
    monotonicNs: 5n,
    realtimeOffsetNs: 0n,
  };
}

function store(): SealedStore {
  return {
    identity: IDENTITY,
    lower: LOWER,
    files: [
      { name: "data", bytes: bytes(70_000, 1) },
      { name: "journal-b", bytes: bytes(3_000, 2) },
      { name: "meta", bytes: bytes(512, 3) },
    ],
  };
}

function sealed(memoryBytes = 50_000): PageSeal {
  return { ...memory(memoryBytes), rootStore: store() };
}

/** A fresh store that records what the restore does to it. */
function fakeTarget(
  log: string[],
  replaysTo: StoreIdentity = IDENTITY,
  lower = LOWER,
): StoreRestoreTarget & { files: Map<StoreFileName, Uint8Array> } {
  const files = new Map<StoreFileName, Uint8Array>();
  return {
    files,
    materializeLower: (image) => {
      log.push(`lower from ${image.byteLength} bytes`);
      return Promise.resolve(lower);
    },
    write: (name, offset, chunk) => {
      const had = files.get(name) ?? new Uint8Array(0);
      if (had.byteLength === 0) log.push(name);
      assertEquals(offset, had.byteLength, `${name} is written in order`);
      const grown = new Uint8Array(had.byteLength + chunk.byteLength);
      grown.set(had);
      grown.set(chunk, had.byteLength);
      files.set(name, grown);
      return Promise.resolve();
    },
    complete: () => {
      log.push("complete");
      return Promise.resolve(replaysTo);
    },
    discard: () => {
      log.push("discard");
      return Promise.resolve();
    },
  };
}

/** A gzipped snapshot file of `header` as written and `body` after it. */
async function rawSnapshot(
  header: Record<string, unknown>,
  ...body: Uint8Array[]
): Promise<Blob> {
  const json = new TextEncoder().encode(JSON.stringify(header));
  const length = new Uint8Array(4);
  new DataView(length.buffer).setUint32(0, json.byteLength, true);
  return await new Response(
    new Blob([length, json, ...body as Uint8Array<ArrayBuffer>[]]).stream()
      .pipeThrough(new CompressionStream("gzip")),
  ).blob();
}

async function inflate(file: Blob): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(
    await new Response(
      file.stream().pipeThrough(new DecompressionStream("gzip")),
    ).arrayBuffer(),
  );
}

const image = () => Promise.resolve(new Uint8Array(100));

Deno.test("a store snapshot restores its store into a fresh one in export order, then its memory", async () => {
  const seal = sealed();
  const file = await encodeSandboxSnapshot(seal, BUILT);
  const log: string[] = [];
  const target = fakeTarget(log);
  const restored = await decodeSandboxSnapshot(
    file.stream(),
    BUILT,
    undefined,
    undefined,
    { target, expect: IDENTITY, image },
  );
  assertEquals(log, [
    "lower from 100 bytes",
    "data",
    "journal-b",
    "meta",
    "complete",
  ]);
  for (const { name, bytes } of seal.rootStore!.files) {
    assertEquals(target.files.get(name), bytes, name);
  }
  const { rootStore: _store, ...memoryOnly } = seal;
  assertEquals(restored, memoryOnly);
});

Deno.test("a store snapshot's header names its format, each store file's size and sha256, and the store's identity", async () => {
  const seal = sealed();
  const facts = await snapshotHeaderFacts(
    (await encodeSandboxSnapshot(seal, BUILT)).stream(),
  );
  assertEquals(facts.format, STORE_FORMAT);
  assertEquals(facts.store, {
    identity: IDENTITY,
    files: await Promise.all(
      seal.rootStore!.files.map(async ({ name, bytes }) => ({
        name,
        bytes: bytes.byteLength,
        sha256: await sha256Hex(bytes),
      })),
    ),
    lower: LOWER,
  });
  // A memory-only seal stays format 3, with no store.
  const plain = await snapshotHeaderFacts(
    (await encodeSandboxSnapshot(memory(16), BUILT)).stream(),
  );
  assertEquals([plain.format, plain.store], [FORMAT, undefined]);
});

Deno.test("a store that replays to another identity is refused before the memory is allocated", async () => {
  const seal = sealed();
  const facts = await snapshotHeaderFacts(
    (await encodeSandboxSnapshot(seal, BUILT)).stream(),
  );
  // 4 PiB: allocating it first would throw a RangeError, not the mismatch.
  const file = await rawSnapshot(
    {
      format: STORE_FORMAT,
      builtFrom: BUILT,
      memoryBytes: 2 ** 52,
      store: facts.store,
    },
    ...seal.rootStore!.files.map(({ bytes }) => bytes),
  );
  const log: string[] = [];
  await assertRejects(
    () =>
      decodeSandboxSnapshot(file.stream(), BUILT, undefined, undefined, {
        target: fakeTarget(log, OTHER),
        expect: IDENTITY,
        image,
      }),
    SnapshotMismatch,
    "the store is lineage 1111",
  );
  assertEquals(log.at(-1), "complete");
});

Deno.test("a snapshot whose header binds another store than the pin's is refused before anything is written", async () => {
  const file = await encodeSandboxSnapshot(sealed(), BUILT);
  const log: string[] = [];
  await assertRejects(
    () =>
      decodeSandboxSnapshot(file.stream(), BUILT, undefined, undefined, {
        target: fakeTarget(log),
        expect: OTHER,
        image,
      }),
    SnapshotMismatch,
    "header says the store is",
  );
  assertEquals(log, []);
});

Deno.test("a store made over another lower than the image materializes is refused before its files are written", async () => {
  const file = await encodeSandboxSnapshot(sealed(), BUILT);
  const log: string[] = [];
  await assertRejects(
    () =>
      decodeSandboxSnapshot(file.stream(), BUILT, undefined, undefined, {
        target: fakeTarget(log, IDENTITY, {
          ...LOWER,
          sha256: "44".repeat(32),
        }),
        expect: IDENTITY,
        image,
      }),
    SnapshotMismatch,
    "lower.tar",
  );
  assertEquals(log, ["lower from 100 bytes"]);
});

Deno.test("a store snapshot cut inside a store file is refused as truncated", async () => {
  const raw = await inflate(await encodeSandboxSnapshot(sealed(0), BUILT));
  // Into the data file: the journal, meta and memory never come.
  const cut = await new Response(
    new Blob([raw.subarray(0, raw.byteLength - 4_000)]).stream().pipeThrough(
      new CompressionStream("gzip"),
    ),
  ).blob();
  const log: string[] = [];
  await assertRejects(
    () =>
      decodeSandboxSnapshot(cut.stream(), BUILT, undefined, undefined, {
        target: fakeTarget(log),
        expect: IDENTITY,
        image,
      }),
    Error,
    "of the store's data",
  );
  assert(!log.includes("complete"));
});

Deno.test("each kernel restores only its own snapshot format, and says why it refuses the other", async () => {
  const memoryOnly = await encodeSandboxSnapshot(memory(16), BUILT);
  await assertRejects(
    () =>
      decodeSandboxSnapshot(memoryOnly.stream(), BUILT, undefined, undefined, {
        target: fakeTarget([]),
        expect: IDENTITY,
        image,
      }),
    SnapshotMismatch,
    "format 3, not 4: the kernel's memory alone, and this kernel's root filesystem is a YurtFS store",
  );
  const withStore = await encodeSandboxSnapshot(sealed(), BUILT);
  await assertRejects(
    () => decodeSandboxSnapshot(withStore.stream(), BUILT),
    SnapshotMismatch,
    "format 4, not 3: it carries a YurtFS root store",
  );
});

/** Pins naming BUILT's kernel, image and Python seal, with `snapshot`. */
function pinsWith(snapshot: Record<string, unknown>) {
  const pin = (sha256: string) => ({
    repo: "r",
    rev: BUILT.kernelRev,
    build: "b",
    path: "p",
    sha256,
  });
  return parsePins({
    kernelWasm: pin(BUILT.kernelSha256),
    image: pin("full"),
    browserImage: pin(BUILT.imageSha256),
    pythonSeal: { sha256: BUILT.pythonSealSha256 },
    snapshot,
  });
}

async function storePin(): Promise<SnapshotPin> {
  const facts = await snapshotHeaderFacts(
    (await encodeSandboxSnapshot(sealed(), BUILT)).stream(),
  );
  return {
    releaseRepo: "r",
    release: "t",
    format: STORE_FORMAT,
    sha256: "00".repeat(32),
    size: 1,
    parts: ["00".repeat(32)],
    builtFrom: BUILT,
    store: facts.store,
  };
}

Deno.test("a pin is taken only by the kernel its format is for; the release tools take either", async () => {
  const withStore = await storePin();
  const { store: _store, ...memoryOnly } = { ...withStore, format: FORMAT };
  for (const entry of [withStore, memoryOnly]) {
    const pins = pinsWith(entry);
    assertEquals(pinnedSnapshot(pins).format, entry.format, "either");
    const own = entry.format === STORE_FORMAT;
    assertEquals(pinnedSnapshot(pins, "desktop", own).format, entry.format);
    assertThrows(
      () => pinnedSnapshot(pins, "desktop", !own),
      SnapshotMismatch,
      own ? "format 4, not 3" : "format 3, not 4: the kernel's memory alone",
    );
  }
  assertThrows(
    () => pinnedSnapshot(pinsWith({ ...memoryOnly, format: 5 })),
    SnapshotMismatch,
    "format 5, not 3 or 4",
  );
});

Deno.test("a format-4 pin must carry its store, in export order, and no other format carries one", async () => {
  const pin = await storePin();
  assertEquals(parseSnapshotPin(pin).store, pin.store);
  const { store, ...bare } = pin;
  const files = store!.files;
  const wrong: [Record<string, unknown>, string][] = [
    [bare, "store is required in format 4"],
    [{ ...pin, format: FORMAT }, "store is only in format 4"],
    [
      { ...pin, store: { ...store, files: [files[2], files[1], files[0]] } },
      "not data, the active journal, then meta",
    ],
    [
      { ...pin, store: { ...store, files: [files[0], files[2]] } },
      "not data, the active journal, then meta",
    ],
    [
      { ...pin, store: { ...store, identity: { ...IDENTITY, sequence: 42 } } },
      "store.identity",
    ],
    [{ ...pin, store: { ...store, lower: { bytes: 0 } } }, "store.lower"],
  ];
  for (const [entry, why] of wrong) {
    assertThrows(() => parseSnapshotPin(entry), PinResolutionError, why);
  }
});

Deno.test("a seal with its store collects each exported file whole and in order, and refuses any other export", async () => {
  const want = store();
  const api = (
    write: (sink: Parameters<RootStoreApi["sealSandbox"]>[1]["sink"]) => void,
  ): RootStoreApi => ({
    freshStore: () => Promise.reject(new Error("not in this test")),
    restore: () => Promise.reject(new Error("not in this test")),
    sealSandbox: (_host, { sink }) => {
      write(sink);
      return Promise.resolve({
        image: memory(16),
        identity: IDENTITY,
        lower: LOWER,
      });
    },
  });
  const host = {} as KernelHostInterface;
  // In 1000-byte chunks, through one reused buffer, as the kernel's
  // export may hand them.
  const seal = await sealWithStore(
    api((sink) => {
      const buffer = new Uint8Array(1000);
      for (const { name, bytes } of want.files) {
        for (let at = 0; at < bytes.byteLength; at += 1000) {
          const chunk = bytes.subarray(at, at + 1000);
          buffer.set(chunk);
          sink(name, at, buffer.subarray(0, chunk.byteLength));
        }
      }
    }),
    host,
  );
  assertEquals(seal.rootStore, want);
  assertEquals(seal.kernelMemory, memory(16).kernelMemory);
  await assertRejects(
    () =>
      sealWithStore(
        api((sink) => {
          sink("data", 0, new Uint8Array(4));
          sink("data", 8, new Uint8Array(4));
        }),
        host,
      ),
    Error,
    "wrote data at 8, not at its end 4",
  );
  await assertRejects(
    () =>
      sealWithStore(
        api((sink) => {
          sink("meta", 0, new Uint8Array(4));
          sink("journal-a", 0, new Uint8Array(4));
          sink("data", 0, new Uint8Array(4));
        }),
        host,
      ),
    Error,
    "not data, the active journal, then meta",
  );
  // Nor is an export out of order written into a snapshot.
  await assertRejects(
    () =>
      encodeSandboxSnapshot({
        ...memory(16),
        rootStore: { ...want, files: want.files.slice(1) },
      }, BUILT),
    Error,
    "cannot write the snapshot",
  );
});

Deno.test("the pinned kernel has no root store: every snapshot stays the kernel memory alone", () => {
  assertEquals(rootStoreOf(KernelHostInterface), undefined);
  assertEquals(rootStoreOf(undefined), undefined);
  assertEquals(rootStoreOf({ rootStore: { freshStore() {} } }), undefined);
});

/** A site serving `file` in 64-byte parts at `name`, and the pin for it. */
async function served(
  name: string,
  file: Uint8Array<ArrayBuffer>,
  pin: Omit<SnapshotPin, "sha256" | "size" | "parts">,
): Promise<{ fetch: typeof fetch; pin: SnapshotPin }> {
  const PART = 64;
  const base = name.slice(name.lastIndexOf("/") + 1);
  const parts = Array.from(
    { length: Math.ceil(file.byteLength / PART) },
    (_, i) => file.slice(i * PART, (i + 1) * PART),
  );
  const names = parts.map((_, i) => `${base}.${i}`);
  return {
    pin: {
      ...pin,
      sha256: await sha256Hex(file),
      size: file.byteLength,
      parts: await Promise.all(parts.map((part) => sha256Hex(part))),
    },
    fetch: (input) => {
      const path = new URL(String(input), "http://pg/").pathname;
      if (path === `/${name}.parts.json`) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ size: file.byteLength, parts: names }),
          ),
        );
      }
      const index = names.findIndex((part) => path.endsWith(`/${part}`));
      return Promise.resolve(
        index < 0
          ? new Response(null, { status: 404 })
          : new Response(parts[index]),
      );
    },
  };
}

Deno.test("?snapshot=1 on a kernel with a root store restores the store, then the kernel over it, and discards a store it refused", async () => {
  const raw = JSON.parse(
    await Deno.readTextFile(new URL("../artifacts/pins.json", import.meta.url)),
  );
  const built = {
    ...snapshotIdentity(parsePins({ ...raw, snapshot: undefined })),
    pythonSet: null,
  };
  const seal = sealed(4_000);
  const file = new Uint8Array(
    await (await encodeSandboxSnapshot(seal, built)).arrayBuffer(),
  );
  const facts = await snapshotHeaderFacts(new Blob([file]).stream());
  const name = "snapshot/sandbox.seal.gz";
  const site = await served(name, file, {
    releaseRepo: "r",
    release: "t",
    format: facts.format,
    builtFrom: built,
    memoryBytes: facts.memoryBytes,
    store: facts.store,
  });
  const pinsText = JSON.stringify({ ...raw, snapshot: site.pin });
  const realFetch = globalThis.fetch;
  globalThis.fetch =
    ((input: RequestInfo | URL, init?: RequestInit) =>
      String(input).endsWith("pins.json")
        ? Promise.resolve(new Response(pinsText))
        : site.fetch(input, init)) as typeof fetch;
  const log: string[] = [];
  const api = (replaysTo: StoreIdentity): RootStoreApi => ({
    freshStore: () => {
      log.push("fresh store");
      return Promise.resolve(fakeTarget(log, replaysTo));
    },
    sealSandbox: () => Promise.reject(new Error("not in this test")),
    restore: (_kernel, image, store) => {
      log.push(`restore ${image.kernelMemory.byteLength} bytes`);
      assertEquals(store.expect, IDENTITY);
      assertEquals(image.kernelMemory, seal.kernelMemory);
      return Promise.resolve({
        host: { dispose() {} } as unknown as KernelHostInterface,
        processes: [],
      });
    },
  });
  const env = {
    isolated: true,
    fetchBytes: (path: string) => {
      log.push(`fetch ${path}`);
      return Promise.resolve(new Uint8Array(100));
    },
    imagePath: "./playground-slim.yurtimg",
    show: () => {},
    term: {} as never,
  };
  try {
    await restoreSnapshot(
      env,
      new Uint8Array(),
      `http://pg/${name}`,
      api(IDENTITY),
    );
    assertEquals(log, [
      "fresh store",
      "fetch ./playground-slim.yurtimg",
      "lower from 100 bytes",
      "data",
      "journal-b",
      "meta",
      "complete",
      "restore 4000 bytes",
    ]);
    log.length = 0;
    await assertRejects(
      () =>
        restoreSnapshot(env, new Uint8Array(), `http://pg/${name}`, api(OTHER)),
      SnapshotMismatch,
      "restoring the snapshot's store",
    );
    assertEquals(log.slice(-2), ["complete", "discard"]);
    // The same pin on a kernel without a root store is refused unread.
    log.length = 0;
    await assertRejects(
      () =>
        restoreSnapshot(env, new Uint8Array(), `http://pg/${name}`, undefined),
      SnapshotMismatch,
      "format 4, not 3",
    );
    assertEquals(log, []);
  } finally {
    globalThis.fetch = realFetch;
  }
});
