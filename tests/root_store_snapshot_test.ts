// A snapshot zip of a sandbox whose root is a YurtFS store
// (src/root_store.ts), against a fake of the kernel host's root store API:
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

/** Not compressible much (a deflated entry keeps its size order). */
function bytes(length: number, seed: number): Uint8Array {
  let x = seed * 2654435761 >>> 0;
  return Uint8Array.from({ length }, () => {
    x = (x * 1664525 + 1013904223) >>> 0;
    return x >>> 24;
  });
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

function store(): SealedStore & {
  files: { name: StoreFileName; bytes: Uint8Array }[];
} {
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

/** The entry names of a zip, from its central directory (as an unzip
 * tool lists them, not as this page's reader walks them). */
async function zipNames(file: Blob): Promise<string[]> {
  const raw = new Uint8Array(await file.arrayBuffer());
  const view = new DataView(raw.buffer);
  const end = raw.byteLength - 22;
  assertEquals(view.getUint32(end, true), 0x06054b50, "end of central dir");
  const names: string[] = [];
  let at = view.getUint32(end + 16, true);
  for (let i = 0; i < view.getUint16(end + 10, true); i++) {
    assertEquals(view.getUint32(at, true), 0x02014b50);
    const length = view.getUint16(at + 28, true);
    names.push(
      new TextDecoder().decode(raw.subarray(at + 46, at + 46 + length)),
    );
    at += 46 + length + view.getUint16(at + 30, true) +
      view.getUint16(at + 32, true);
  }
  return names;
}

const image = () => Promise.resolve(new Uint8Array(100));

/** Whether `a` and `b` hold the same bytes (a boolean, not a diff: an
 * assertEquals diff of large byte arrays crashes Deno 2.7). */
function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.byteLength === b.byteLength && a.every((byte, i) => byte === b[i]);
}

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
  // A store with no file data yet: its empty data file still reaches the
  // target, which so knows it exists.
  const pristine = {
    ...memory(16),
    rootStore: {
      ...store(),
      files: [
        { name: "data" as const, bytes: [] },
        ...store().files.slice(1),
      ],
    },
  };
  const pristineLog: string[] = [];
  const pristineTarget = fakeTarget(pristineLog);
  await decodeSandboxSnapshot(
    (await encodeSandboxSnapshot(pristine, BUILT)).stream(),
    BUILT,
    undefined,
    undefined,
    { target: pristineTarget, expect: IDENTITY, image },
  );
  assertEquals(pristineLog.slice(1, 4), ["data", "journal-b", "meta"]);
  assertEquals(pristineTarget.files.get("data")?.byteLength, 0);
});

Deno.test("a snapshot is a zip of its manifest, the store files in export order, then the memory", async () => {
  const file = await encodeSandboxSnapshot(sealed(), BUILT);
  const facts = await snapshotHeaderFacts(file.stream());
  assertEquals([facts.format, facts.store], [FORMAT, { identity: IDENTITY }]);
  assertEquals(await zipNames(file), [
    "snapshot.json",
    "store/data",
    "store/journal-b",
    "store/meta",
    "kernel-memory",
  ]);
  // A memory-only seal is the same format, without the store.
  const plain = await encodeSandboxSnapshot(memory(16), BUILT);
  const plainFacts = await snapshotHeaderFacts(plain.stream());
  assertEquals([plainFacts.format, plainFacts.store], [FORMAT, undefined]);
  assertEquals(await zipNames(plain), ["snapshot.json", "kernel-memory"]);
});

Deno.test("a store that replays to another identity is refused, and only once the whole zip was read", async () => {
  const file = await encodeSandboxSnapshot(sealed(), BUILT);
  const log: string[] = [];
  let ended = false;
  const target = fakeTarget(log, OTHER);
  const complete = target.complete;
  // The replay parses the store: never before the stream (and so its
  // hash, when it is a download) has ended.
  target.complete = () => {
    log.push(ended ? "after the end" : "before the end");
    return complete();
  };
  const body = file.stream().pipeThrough(
    new TransformStream({ flush: () => void (ended = true) }),
  );
  await assertRejects(
    () =>
      decodeSandboxSnapshot(body, BUILT, undefined, undefined, {
        target,
        expect: IDENTITY,
        image,
      }),
    SnapshotMismatch,
    "the store is lineage 1111",
  );
  assertEquals(log.slice(-2), ["after the end", "complete"]);
});

Deno.test("a snapshot whose manifest binds another store than the pin's is refused before anything is written", async () => {
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
    "manifest says the store is",
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
  const raw = new Uint8Array(
    await (await encodeSandboxSnapshot(sealed(0), BUILT)).arrayBuffer(),
  );
  // Into the data entry: the journal, meta and memory never come.
  const cut = new Blob([raw.subarray(0, 20_000)]);
  const log: string[] = [];
  await assertRejects(
    () =>
      decodeSandboxSnapshot(cut.stream(), BUILT, undefined, undefined, {
        target: fakeTarget(log),
        expect: IDENTITY,
        image,
      }),
    Error,
    "truncated (",
  );
  assertEquals(log, ["lower from 100 bytes", "data"]);
});

Deno.test("each kernel restores only its own kind of zip, and says why it refuses the other", async () => {
  const memoryOnly = await encodeSandboxSnapshot(memory(16), BUILT);
  await assertRejects(
    () =>
      decodeSandboxSnapshot(memoryOnly.stream(), BUILT, undefined, undefined, {
        target: fakeTarget([]),
        expect: IDENTITY,
        image,
      }),
    SnapshotMismatch,
    "holds the kernel memory alone, and this kernel's root filesystem is a YurtFS store",
  );
  const withStore = await encodeSandboxSnapshot(sealed(), BUILT);
  await assertRejects(
    () => decodeSandboxSnapshot(withStore.stream(), BUILT),
    SnapshotMismatch,
    "carries a YurtFS root store, and this kernel keeps its root filesystem in its memory",
  );
  // The release tools' full check takes either, writing no store.
  const checked = await decodeSandboxSnapshot(
    withStore.stream(),
    BUILT,
    undefined,
    undefined,
    "either",
  );
  assertEquals(checked.kernelMemory, sealed().kernelMemory);
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
    format: facts.format,
    sha256: "00".repeat(32),
    size: 1,
    builtFrom: BUILT,
    store: facts.store,
  };
}

Deno.test("a pin is taken only by the kernel its zip is for; the release tools take either", async () => {
  const withStore = await storePin();
  const { store: _store, ...memoryOnly } = withStore;
  for (const entry of [withStore, memoryOnly]) {
    const pins = pinsWith(entry);
    const own = entry === withStore;
    const want = (entry as SnapshotPin).store;
    assertEquals(pinnedSnapshot(pins).store, want, "either");
    assertEquals(pinnedSnapshot(pins, "desktop", own).store, want);
    assertThrows(
      () => pinnedSnapshot(pins, "desktop", !own),
      SnapshotMismatch,
      own ? "carries a YurtFS root store" : "holds the kernel memory alone",
    );
  }
  // A gzip of before the zip is refused by every kernel, saying so.
  for (const rootStore of [undefined, false, true]) {
    assertThrows(
      () =>
        pinnedSnapshot(
          pinsWith({ ...memoryOnly, format: 3 }),
          "desktop",
          rootStore,
        ),
      SnapshotMismatch,
      "format 3, not 4: a gzip of the kernel memory, from before the zip",
    );
  }
});

Deno.test("a pin carries one sha256 for the whole zip and, with a store, only its identity", async () => {
  const pin = await storePin();
  assertEquals(parseSnapshotPin(pin), pin);
  assertEquals(Object.keys(pin.store!), ["identity"]);
  assertEquals("parts" in parseSnapshotPin({ ...pin, parts: ["00"] }), false);
  for (
    const identity of [
      { ...IDENTITY, sequence: 42 },
      { ...IDENTITY, sequence: "042" },
      { ...IDENTITY, lineage: "11" },
      { ...IDENTITY, hash: undefined },
    ]
  ) {
    assertThrows(
      () => parseSnapshotPin({ ...pin, store: { identity } }),
      PinResolutionError,
      "store.identity",
    );
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
  // Kept as the chunks the export handed over, never joined.
  const { files, ...rest } = seal.rootStore!;
  assertEquals(rest, { identity: IDENTITY, lower: LOWER });
  assertEquals(
    files.map(({ name }) => name),
    want.files.map(({ name }) => name),
  );
  for (const [i, { bytes }] of files.entries()) {
    assert(Array.isArray(bytes), files[i].name);
    assert(
      equalBytes(
        new Uint8Array(bytes.flatMap((chunk) => [...chunk])),
        want.files[i].bytes,
      ),
      files[i].name,
    );
  }
  assertEquals(seal.kernelMemory, memory(16).kernelMemory);
  // An empty data file the export never hands the sink is still there.
  const pristine = await sealWithStore(
    api((sink) => {
      sink("journal-a", 0, new Uint8Array(4));
      sink("meta", 0, new Uint8Array(4));
    }),
    host,
  );
  assertEquals(
    pristine.rootStore!.files.map(({ name }) => name),
    ["data", "journal-a", "meta"],
  );
  await encodeSandboxSnapshot(pristine, BUILT);
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

Deno.test("the pinned kernel has no root store: every snapshot zip is the kernel memory alone", () => {
  assertEquals(rootStoreOf(KernelHostInterface), undefined);
  assertEquals(rootStoreOf(undefined), undefined);
  assertEquals(rootStoreOf({ rootStore: { freshStore() {} } }), undefined);
});

/** A site serving `file` in 64-byte parts at `name`, and the pin for it. */
async function served(
  name: string,
  file: Uint8Array<ArrayBuffer>,
  pin: Omit<SnapshotPin, "sha256" | "size">,
): Promise<{ fetch: typeof fetch; pin: SnapshotPin }> {
  const PART = 64;
  const base = name.slice(name.lastIndexOf("/") + 1);
  const parts = Array.from(
    { length: Math.ceil(file.byteLength / PART) },
    (_, i) => file.slice(i * PART, (i + 1) * PART),
  );
  const names = parts.map((_, i) => `${base}.${i}`);
  return {
    pin: { ...pin, sha256: await sha256Hex(file), size: file.byteLength },
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
  const name = "snapshot/sandbox.seal.zip";
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
  const api = (replaysTo: StoreIdentity, processes = 0): RootStoreApi => ({
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
        host: {
          dispose: () => log.push("dispose"),
        } as unknown as KernelHostInterface,
        processes: Array.from({ length: processes }, () => ({}) as never),
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
  const url = `http://pg/${name}`;
  try {
    const restored = await restoreSnapshot(
      env,
      new Uint8Array(),
      url,
      api(IDENTITY),
    );
    // A boot that falls back after the restore (its shell would not
    // start) discards the store too.
    await restored.discard();
    assertEquals(log.at(-1), "discard");
    log.pop();
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
      () => restoreSnapshot(env, new Uint8Array(), url, api(OTHER)),
      SnapshotMismatch,
      "restoring the snapshot's store",
    );
    assertEquals(log.slice(-2), ["complete", "discard"]);
    // A restore that brings a process back is refused, its store too.
    log.length = 0;
    await assertRejects(
      () => restoreSnapshot(env, new Uint8Array(), url, api(IDENTITY, 1)),
      Error,
      "must hold no process",
    );
    assertEquals(log.slice(-2), ["dispose", "discard"]);
    // The same pin on a kernel without a root store is refused unread.
    log.length = 0;
    await assertRejects(
      () => restoreSnapshot(env, new Uint8Array(), url, undefined),
      SnapshotMismatch,
      "carries a YurtFS root store",
    );
    assertEquals(log, []);
  } finally {
    globalThis.fetch = realFetch;
  }
});

Deno.test("a zip whose bytes are not the pinned ones is never restored, even with every entry well formed", async () => {
  const raw = JSON.parse(
    await Deno.readTextFile(new URL("../artifacts/pins.json", import.meta.url)),
  );
  const built = {
    ...snapshotIdentity(parsePins({ ...raw, snapshot: undefined })),
    pythonSet: null,
  };
  const file = new Uint8Array(
    await (await encodeSandboxSnapshot(sealed(4_000), built)).arrayBuffer(),
  );
  const facts = await snapshotHeaderFacts(new Blob([file]).stream());
  const name = "snapshot/sandbox.seal.zip";
  const pinned = await served(name, file, {
    releaseRepo: "r",
    release: "t",
    format: facts.format,
    builtFrom: built,
    memoryBytes: facts.memoryBytes,
    store: facts.store,
  });
  // One byte off in the central directory, which the page never parses:
  // every entry still reads, and only the whole zip's hash differs.
  const tampered = file.slice();
  tampered[tampered.byteLength - 30] ^= 0xff;
  const site = await served(name, tampered, pinned.pin);
  const pinsText = JSON.stringify({ ...raw, snapshot: pinned.pin });
  const realFetch = globalThis.fetch;
  globalThis.fetch =
    ((input: RequestInfo | URL, init?: RequestInit) =>
      String(input).endsWith("pins.json")
        ? Promise.resolve(new Response(pinsText))
        : site.fetch(input, init)) as typeof fetch;
  const log: string[] = [];
  try {
    await assertRejects(
      () =>
        restoreSnapshot(
          {
            isolated: true,
            fetchBytes: () => Promise.resolve(new Uint8Array(100)),
            show: () => {},
            term: {} as never,
          },
          new Uint8Array(),
          `http://pg/${name}`,
          {
            freshStore: () => Promise.resolve(fakeTarget(log)),
            sealSandbox: () => Promise.reject(new Error("not in this test")),
            restore: () => {
              log.push("restore");
              return Promise.reject(new Error("restored unverified bytes"));
            },
          },
        ),
      Error,
      "not the pinned",
    );
    assert(!log.includes("restore"), log.join(", "));
    assertEquals(log.at(-1), "discard");
    // Its store was written but never replayed: the hash failed first.
    assert(!log.includes("complete"), log.join(", "));
  } finally {
    globalThis.fetch = realFetch;
  }
});
