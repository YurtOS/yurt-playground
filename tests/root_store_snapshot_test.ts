// A snapshot zip of a sandbox whose root is a YurtFS store
// (src/root_store.ts), against an in-memory fake of the proposed kernel
// host API (ProposedRootStoreApi): the kernel side does not exist yet
// (yurtos-kernel#4089 Task 5.4b, Slice 7). The store is format v2: one
// file per regular inode under content/, the active journal, meta.
import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  KernelHostInterface,
  type SandboxSealImage,
} from "@yurt/kernel-host-interface-js";
import { kernelRootIsStore } from "../scripts/lib/snapshot_file.ts";
import { restoreSnapshot } from "../src/boot.ts";
import { sha256Hex } from "../src/integrity.ts";
import {
  parsePins,
  parseSnapshotPin,
  PinResolutionError,
} from "../src/pins.ts";
import {
  type PageSeal,
  type ProposedRootStoreApi,
  rootStoreOf,
  type SealedStore,
  sealWithStore,
  type StoreExportSink,
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
import {
  STORE_PIECE_BYTES,
  type StoreFileName,
  StoreLogReader,
  StoreLogWriter,
} from "../src/store_log.ts";

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
const PIECE = STORE_PIECE_BYTES;

/** Not compressible much (a deflated entry keeps its size order). */
function bytes(length: number, seed: number): Uint8Array {
  let x = seed * 2654435761 >>> 0;
  return Uint8Array.from({ length }, () => {
    x = (x * 1664525 + 1013904223) >>> 0;
    return x >>> 24 | 1;
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

/** A store's files as the kernel holds them: whole, holes as zeros. */
type StoreFiles = { name: StoreFileName; bytes: Uint8Array }[];

/** A sparse file: zeros but for `at`, two pieces in, so the export skips
 * its first pieces and its tail. */
function sparse(length: number, at: number, seed: number): Uint8Array {
  const out = new Uint8Array(length);
  out.set(bytes(1_000, seed), at);
  return out;
}

const FILES: StoreFiles = [
  { name: "content/12", bytes: bytes(70_000, 1) },
  { name: "content/7", bytes: sparse(5 * PIECE + 17, 2 * PIECE + 5, 4) },
  { name: "content/9", bytes: new Uint8Array(0) },
  { name: "content/18446744073709551615", bytes: new Uint8Array(PIECE) },
  { name: "journal-b", bytes: bytes(3_000, 2) },
  { name: "meta", bytes: bytes(512, 3) },
];

/** What the kernel's export does with `files` (yurtos-kernel export.rs,
 * and the per-inode amendment's section 7): each file in 64 KiB pieces
 * from offset 0, all-zero pieces skipped, through one reused buffer, then
 * its length. */
function exportTo(sink: StoreExportSink, files: StoreFiles): void {
  const buffer = new Uint8Array(PIECE);
  for (const { name, bytes } of files) {
    for (let at = 0; at < bytes.byteLength; at += PIECE) {
      const piece = bytes.subarray(at, at + PIECE);
      if (piece.every((byte) => byte === 0)) continue;
      buffer.set(piece);
      sink.write(name, at, buffer.subarray(0, piece.byteLength));
    }
    sink.setLength(name, bytes.byteLength);
  }
}

function store(files: StoreFiles = FILES): SealedStore {
  const log = new StoreLogWriter();
  exportTo(log, files);
  return {
    identity: IDENTITY,
    lower: LOWER,
    ...log.finish(),
    log: log.chunks,
  };
}

function sealed(memoryBytes = 50_000, files?: StoreFiles): PageSeal {
  return { ...memory(memoryBytes), rootStore: store(files) };
}

/** The pin a restore checks the manifest's store against. */
function expectOf(seal: PageSeal) {
  const { identity, files, bytes } = seal.rootStore!;
  return { identity, files, bytes };
}

/** A fresh store that records what the restore does to it: each file's
 * pieces where they were written (a gap none wrote is a hole) and its
 * length. */
function fakeTarget(
  log: string[],
  replaysTo: StoreIdentity = IDENTITY,
  lower = LOWER,
): StoreRestoreTarget & {
  files: Map<string, { pieces: [number, Uint8Array][]; length?: number }>;
  read(name: string): Uint8Array;
} {
  const files = new Map<
    string,
    { pieces: [number, Uint8Array][]; length?: number }
  >();
  const fileOf = (name: string) => {
    let file = files.get(name);
    if (file === undefined) {
      log.push(name);
      file = { pieces: [] };
      files.set(name, file);
    }
    return file;
  };
  return {
    files,
    read(name) {
      const file = files.get(name)!;
      const out = new Uint8Array(file.length!);
      for (const [offset, piece] of file.pieces) out.set(piece, offset);
      return out;
    },
    materializeLower: (image) => {
      log.push(`lower from ${image.byteLength} bytes`);
      return Promise.resolve(lower);
    },
    write: (name, offset, chunk) => {
      fileOf(name).pieces.push([offset, chunk.slice()]);
      return Promise.resolve();
    },
    setLength: (name, length) => {
      fileOf(name).length = length;
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

Deno.test("a store snapshot restores its store into a fresh one in export order, holes as holes, then its memory", async () => {
  const seal = sealed();
  const file = await encodeSandboxSnapshot(seal, BUILT);
  const log: string[] = [];
  const target = fakeTarget(log);
  const restored = await decodeSandboxSnapshot(
    file.stream(),
    BUILT,
    undefined,
    undefined,
    { target, expect: expectOf(seal), image },
  );
  assertEquals(log, [
    "lower from 100 bytes",
    ...FILES.map(({ name }) => name),
    "complete",
  ]);
  for (const { name, bytes } of FILES) {
    assert(equalBytes(target.read(name), bytes), name);
  }
  // Only the pieces that hold anything were written: the sparse file's
  // one piece, the empty and the all-zero file none (their length made
  // them), and the 70,000 bytes in two.
  const offsets = (name: string) =>
    target.files.get(name)!.pieces.map(([offset]) => offset);
  assertEquals(offsets("content/7"), [2 * PIECE]);
  assertEquals(offsets("content/9"), []);
  assertEquals(offsets("content/18446744073709551615"), []);
  assertEquals(offsets("content/12"), [0, PIECE]);
  const { rootStore: _store, ...memoryOnly } = seal;
  assertEquals(restored, memoryOnly);
});

Deno.test("a snapshot is a zip of its manifest, the store's export log, then the memory", async () => {
  const seal = sealed();
  const file = await encodeSandboxSnapshot(seal, BUILT);
  const facts = await snapshotHeaderFacts(file.stream());
  assertEquals([facts.format, facts.store], [FORMAT, expectOf(seal)]);
  assertEquals(facts.store, {
    identity: IDENTITY,
    files: FILES.length,
    bytes: FILES.reduce((sum, { bytes }) => sum + bytes.byteLength, 0),
  });
  assertEquals(await zipNames(file), [
    "snapshot.json",
    "store",
    "kernel-memory",
  ]);
  // A memory-only seal is the same format, without the store.
  const plain = await encodeSandboxSnapshot(memory(16), BUILT);
  const plainFacts = await snapshotHeaderFacts(plain.stream());
  assertEquals([plainFacts.format, plainFacts.store], [FORMAT, undefined]);
  assertEquals(await zipNames(plain), ["snapshot.json", "kernel-memory"]);
});

Deno.test("a store that replays to another identity is refused, and only once the whole zip was read", async () => {
  const seal = sealed();
  const file = await encodeSandboxSnapshot(seal, BUILT);
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
        expect: expectOf(seal),
        image,
      }),
    SnapshotMismatch,
    "the store is lineage 1111",
  );
  assertEquals(log.slice(-2), ["after the end", "complete"]);
});

Deno.test("a snapshot whose manifest names another store than the pin's is refused before anything is written", async () => {
  const seal = sealed();
  const file = await encodeSandboxSnapshot(seal, BUILT);
  const pinned = expectOf(seal);
  for (
    const [expect, why] of [
      [{ ...pinned, identity: OTHER }, "manifest says the store is"],
      [{ ...pinned, files: pinned.files + 1 }, "not the pinned"],
      [{ ...pinned, bytes: pinned.bytes - 1 }, "not the pinned"],
    ] as const
  ) {
    const log: string[] = [];
    await assertRejects(
      () =>
        decodeSandboxSnapshot(file.stream(), BUILT, undefined, undefined, {
          target: fakeTarget(log),
          expect,
          image,
        }),
      SnapshotMismatch,
      why,
    );
    assertEquals(log, []);
  }
});

Deno.test("a store log never writes past the pinned store, even before the zip's hash is checked", async () => {
  // A zip whose manifest (unhashed yet) agrees with its pin but whose log
  // holds more: refused at the piece that passes the pin, which is never
  // written.
  const big = store();
  const small = { ...big, bytes: 70_000 + 2 * PIECE };
  const file = await encodeSandboxSnapshot(
    { ...memory(16), rootStore: small },
    BUILT,
  );
  const log: string[] = [];
  const target = fakeTarget(log);
  await assertRejects(
    () =>
      decodeSandboxSnapshot(file.stream(), BUILT, undefined, undefined, {
        target,
        expect: expectOf({ ...memory(16), rootStore: small }),
        image,
      }),
    Error,
    "goes past the pinned store",
  );
  const written = [...target.files.values()].reduce(
    (sum, { pieces }) =>
      sum + pieces.reduce((n, [, piece]) => n + piece.byteLength, 0),
    0,
  );
  assert(written <= small.bytes, `${written} bytes written`);
  // The piece that would pass it (content/7's, ending 1,000 bytes past
  // the bound) is refused before it is written, not after.
  assertEquals(target.files.get("content/7")?.pieces.length ?? 0, 0);
  assertEquals(log.includes("complete"), false);
  // One that holds less than its pin is refused at its end.
  const short = { ...big, files: big.files + 1 };
  const shortFile = await encodeSandboxSnapshot(
    { ...memory(16), rootStore: short },
    BUILT,
  );
  await assertRejects(
    () =>
      decodeSandboxSnapshot(shortFile.stream(), BUILT, undefined, undefined, {
        target: fakeTarget([]),
        expect: expectOf({ ...memory(16), rootStore: short }),
        image,
      }),
    Error,
    "not the pinned",
  );
});

Deno.test("a store made over another lower than the image materializes is refused before its files are written", async () => {
  const seal = sealed();
  const file = await encodeSandboxSnapshot(seal, BUILT);
  const log: string[] = [];
  await assertRejects(
    () =>
      decodeSandboxSnapshot(file.stream(), BUILT, undefined, undefined, {
        target: fakeTarget(log, IDENTITY, {
          ...LOWER,
          sha256: "44".repeat(32),
        }),
        expect: expectOf(seal),
        image,
      }),
    SnapshotMismatch,
    "lower.tar",
  );
  assertEquals(log, ["lower from 100 bytes"]);
});

Deno.test("a store snapshot cut inside its store log is refused as truncated", async () => {
  const seal = sealed(0);
  const raw = new Uint8Array(
    await (await encodeSandboxSnapshot(seal, BUILT)).arrayBuffer(),
  );
  // Into the log, before meta (the memory, empty here, comes after it).
  const cut = new Blob([raw.subarray(0, raw.byteLength - 4_000)]);
  const log: string[] = [];
  await assertRejects(
    () =>
      decodeSandboxSnapshot(cut.stream(), BUILT, undefined, undefined, {
        target: fakeTarget(log),
        expect: expectOf(seal),
        image,
      }),
    Error,
    "truncated (",
  );
  assertEquals(log.slice(0, 2), ["lower from 100 bytes", "content/12"]);
  assertEquals(log.includes("meta"), false);
});

Deno.test("a store log replays the same however its bytes are split", async () => {
  const writer = new StoreLogWriter();
  exportTo(writer, FILES);
  const totals = writer.finish();
  const whole = new Uint8Array(
    writer.chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0),
  );
  let at = 0;
  for (const chunk of writer.chunks) {
    whole.set(chunk, at);
    at += chunk.byteLength;
  }
  for (const step of [1, 7, 4096, whole.byteLength]) {
    const log: string[] = [];
    const target = fakeTarget(log);
    const reader = new StoreLogReader(target, totals);
    for (let at = 0; at < whole.byteLength; at += step) {
      await reader.push(whole.subarray(at, at + step));
    }
    reader.finish();
    assertEquals(log, FILES.map(({ name }) => name), `${step}-byte chunks`);
    for (const { name, bytes } of FILES) {
      assert(equalBytes(target.read(name), bytes), `${name}, ${step}`);
    }
  }
  // Cut short inside a record, or before meta: refused at the end.
  const cutInRecord = new StoreLogReader(fakeTarget([]), totals);
  await cutInRecord.push(whole.subarray(0, 5));
  assertThrows(() => cutInRecord.finish(), Error, "ends inside a record");
  // A record that is no piece and no length, and a piece past 64 KiB.
  await assertRejects(
    () =>
      new StoreLogReader(fakeTarget([]), totals).push(new Uint8Array([9, 1])),
    Error,
    "tagged 9",
  );
  const huge = whole.slice(0, 2 + "content/12".length + 12);
  new DataView(huge.buffer).setUint32(
    2 + "content/12".length + 8,
    PIECE + 1,
    true,
  );
  await assertRejects(
    () => new StoreLogReader(fakeTarget([]), totals).push(huge),
    Error,
    "past 65536",
  );
});

Deno.test("each kernel restores only its own kind of zip, and says why it refuses the other", async () => {
  const memoryOnly = await encodeSandboxSnapshot(memory(16), BUILT);
  await assertRejects(
    () =>
      decodeSandboxSnapshot(memoryOnly.stream(), BUILT, undefined, undefined, {
        target: fakeTarget([]),
        expect: expectOf(sealed()),
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
  // The release tools' full check takes either, writing no store (and
  // checking its log all the same).
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
    memoryBytes: facts.memoryBytes,
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

Deno.test("a pin carries one sha256 for the whole zip and, with a store, its identity and totals", async () => {
  const pin = await storePin();
  assertEquals(parseSnapshotPin(pin), pin);
  assertEquals(Object.keys(pin.store!), ["identity", "files", "bytes"]);
  for (
    const bad of [
      { ...pin.store, files: 1 },
      { ...pin.store, files: "6" },
      { ...pin.store, bytes: 0 },
      { identity: pin.store!.identity },
    ]
  ) {
    assertThrows(
      () => parseSnapshotPin({ ...pin, store: bad }),
      PinResolutionError,
      "store.",
    );
  }
  // A zip pin records the memory a restore allocates.
  const { memoryBytes: _memoryBytes, ...unsized } = pin;
  assertThrows(
    () => parseSnapshotPin(unsized),
    PinResolutionError,
    "memoryBytes must be a positive integer",
  );
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
      () => parseSnapshotPin({ ...pin, store: { ...pin.store, identity } }),
      PinResolutionError,
      "store.identity",
    );
  }
});

Deno.test("a seal with its store writes down the export as the kernel hands it, and refuses any other order", async () => {
  const api = (
    write: (sink: StoreExportSink) => void,
  ): ProposedRootStoreApi => ({
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
  // Through one reused buffer, as the kernel's export hands its pieces.
  const seal = await sealWithStore(api((sink) => exportTo(sink, FILES)), host);
  const { log, ...rest } = seal.rootStore!;
  assertEquals(rest, {
    identity: IDENTITY,
    lower: LOWER,
    files: FILES.length,
    bytes: FILES.reduce((sum, { bytes }) => sum + bytes.byteLength, 0),
  });
  assert(Array.isArray(log) && log.length > 1, "kept as chunks");
  assertEquals(seal.kernelMemory, memory(16).kernelMemory);
  // Replayed, it is the export again, the pieces' bytes as they were
  // when handed over (the buffer was reused after each).
  const target = fakeTarget([]);
  const reader = new StoreLogReader(target, rest);
  for (const chunk of log) await reader.push(chunk);
  reader.finish();
  for (const { name, bytes } of FILES) {
    assert(equalBytes(target.read(name), bytes), name);
  }
  const refused = async (
    write: (sink: StoreExportSink) => void,
    why: string,
  ) => await assertRejects(() => sealWithStore(api(write), host), Error, why);
  const piece = new Uint8Array(PIECE);
  const end = (sink: StoreExportSink) => {
    sink.setLength("journal-a", 0);
    sink.setLength("meta", 0);
  };
  await refused((sink) => {
    sink.write("content/1", 0, piece);
    sink.write("content/1", 100, piece);
  }, "not at a piece boundary");
  await refused((sink) => {
    sink.write("content/1", PIECE, piece);
    sink.write("content/1", 0, piece);
  }, "not at a piece boundary past");
  await refused(
    (sink) => sink.write("content/1", 0, new Uint8Array(PIECE + 1)),
    "not 1 to 65536",
  );
  await refused((sink) => {
    sink.write("content/1", 0, new Uint8Array(10));
    sink.write("content/1", PIECE, piece);
  }, "not at a piece boundary");
  await refused((sink) => {
    sink.write("content/1", 0, new Uint8Array(10));
    sink.setLength("content/1", 11);
  }, "short of or past its last piece's end 10");
  await refused((sink) => {
    sink.write("content/1", 0, piece);
    sink.setLength("content/1", PIECE - 1);
  }, "short of or past");
  await refused((sink) => {
    sink.write("content/1", 0, piece);
    sink.write("content/2", 0, piece);
  }, "moved to content/2 before giving content/1 its length");
  await refused((sink) => {
    sink.setLength("content/1", 0);
    sink.setLength("content/1", 0);
  }, "went back to content/1");
  await refused((sink) => {
    sink.setLength("journal-a", 0);
    sink.setLength("content/1", 0);
  }, "content files, then the active journal, then meta");
  await refused((sink) => {
    sink.setLength("journal-a", 0);
    sink.setLength("journal-b", 0);
  }, "then the active journal");
  await refused(
    (sink) => sink.setLength("meta", 0),
    "content files, then the active journal, then meta",
  );
  await refused((sink) => {
    end(sink);
    sink.setLength("content/3", 0);
  }, "after meta");
  await refused(
    (sink) => sink.setLength("journal-a", 0),
    "ended before meta",
  );
  for (
    const name of [
      "data",
      "lock",
      "lower.tar",
      "content/0",
      "content/012",
      "content/18446744073709551616",
      "content/../meta",
    ]
  ) {
    await refused(
      (sink) => sink.setLength(name as StoreFileName, 0),
      `names ${JSON.stringify(name)}`,
    );
  }
  // The smallest export: no content file at all.
  await sealWithStore(api(end), host);
});

Deno.test("the pinned kernel has no root store, as the pins record: every snapshot zip is the kernel memory alone", async () => {
  assertEquals(rootStoreOf(KernelHostInterface), undefined);
  // The scripts take the store rule from the pins (kernelWasm.rootStore):
  // it must be the pinned JS host's own.
  const pins = JSON.parse(
    await Deno.readTextFile(new URL("../artifacts/pins.json", import.meta.url)),
  );
  assertEquals(
    kernelRootIsStore(pins),
    rootStoreOf(KernelHostInterface) !== undefined,
  );
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
            JSON.stringify({
              size: file.byteLength,
              partBytes: PART,
              parts: names,
            }),
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
  const api = (
    replaysTo: StoreIdentity,
    processes = 0,
  ): ProposedRootStoreApi => ({
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
      ...FILES.map(({ name }) => name),
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
