import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import type { SandboxSealImage } from "@yurt/kernel-host-interface-js";
import { IMAGE_PART_BYTES } from "../src/image_parts.ts";
import { restoreSnapshot, snapshotOrBoot } from "../src/boot.ts";
import { sha256Hex } from "../src/integrity.ts";
import { writeZip } from "../src/snapshot_zip.ts";
import { parsePins } from "../src/pins.ts";
import {
  BOOT_SETUP,
  type BuiltFrom,
  checkPythonSet,
  checkSandboxSnapshot,
  decodeSandboxSnapshot,
  encodeSandboxSnapshot,
  fetchVerifiedSnapshot,
  FORMAT,
  pinnedSnapshot,
  SEAL_VERSION,
  snapshotHeaderFacts,
  snapshotIdentity,
  SnapshotMismatch,
  type SnapshotPin,
} from "../src/sandbox_snapshot.ts";

function image(memoryBytes: number): SandboxSealImage {
  const kernelMemory = new Uint8Array(memoryBytes);
  for (let i = 0; i < memoryBytes; i += 4093) kernelMemory[i] = i % 251;
  return {
    version: 2,
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

const BUILT: BuiltFrom = {
  kernelSha256: "ab".repeat(32),
  kernelRev: "3d32068f59dcbbffd1aa7a9482e6b5e6f75472b1",
  sealVersion: 2,
  bootSetup: BOOT_SETUP,
  imageSha256: "cd".repeat(32),
  pythonSealSha256: "ef".repeat(32),
  pythonSet: "cd/python@3.14.7-yurt_0:0123456789abcdef",
};

/** A snapshot zip made of `manifest` as written, with `memory` after it:
 * for manifests the encoder does not write. */
function rawSnapshot(
  manifest: Record<string, unknown>,
  memory = new Uint8Array(0),
): Promise<Blob> {
  return writeZip([
    {
      name: "snapshot.json",
      bytes: new TextEncoder().encode(JSON.stringify(manifest)),
      deflate: false,
    },
    { name: "kernel-memory", bytes: memory, deflate: true },
  ]);
}

Deno.test("a sandbox snapshot round-trips its seal image under the build it was made from", async () => {
  const sealed = image(3 * 1024 * 1024 + 5);
  const file = await encodeSandboxSnapshot(sealed, BUILT);
  assertEquals(await decodeSandboxSnapshot(file.stream(), BUILT), sealed);
});

Deno.test("a sandbox snapshot built from anything else is refused, by name", async () => {
  const file = await encodeSandboxSnapshot(image(4096), BUILT);
  const others: Partial<BuiltFrom> = {
    pythonSet: "cd/python@3.14.8-yurt_0:fedcba9876543210",
    kernelSha256: "00".repeat(32),
    kernelRev: "0000000",
    sealVersion: 3,
    bootSetup: BOOT_SETUP + 1,
    imageSha256: "00".repeat(32),
    pythonSealSha256: "00".repeat(32),
  };
  assertEquals(Object.keys(others).sort(), Object.keys(BUILT).sort());
  for (const [key, other] of Object.entries(others)) {
    const expected = { ...BUILT, [key]: other };
    const error = await assertRejects(
      () => decodeSandboxSnapshot(file.stream(), expected),
      SnapshotMismatch,
      `${key} ${BUILT[key as keyof BuiltFrom]}, not ${other}`,
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
  const file = await rawSnapshot({
    format: FORMAT,
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
    format: FORMAT,
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
  const raw = new Uint8Array(
    await (await encodeSandboxSnapshot(image(1 << 20), BUILT)).arrayBuffer(),
  );
  // In its memory, and in its trailer after the memory.
  for (const end of [raw.byteLength / 2, raw.byteLength - 10]) {
    await assertRejects(
      () =>
        decodeSandboxSnapshot(new Blob([raw.subarray(0, end)]).stream(), BUILT),
      Error,
      "truncated",
    );
  }
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
    {
      kernelSha256: "k",
      kernelRev: "v",
      sealVersion: SEAL_VERSION,
      bootSetup: BOOT_SETUP,
      imageSha256: "slim",
      pythonSealSha256: "py",
    },
  );
  assertEquals(
    snapshotIdentity({ kernelWasm: pin("k"), image: pin("full") }),
    {
      kernelSha256: "k",
      kernelRev: "v",
      sealVersion: SEAL_VERSION,
      bootSetup: BOOT_SETUP,
      imageSha256: "full",
      pythonSealSha256: null,
    },
  );
});

/** A site serving `file` in parts at `name` (3-byte parts, so a small
 * file has several). */
function site(name: string, file: Uint8Array<ArrayBuffer>): typeof fetch {
  const base = name.slice(name.lastIndexOf("/") + 1);
  const manifest = {
    size: file.byteLength,
    partBytes: 3,
    parts: Array.from(
      { length: Math.ceil(file.byteLength / 3) },
      (_, i) => `${base}.${i}`,
    ),
  };
  const dir = name.slice(0, name.lastIndexOf("/") + 1);
  return (input) => {
    const path = new URL(String(input), "http://pg/").pathname.slice(1);
    if (path === `${name}.parts.json`) {
      return Promise.resolve(new Response(JSON.stringify(manifest)));
    }
    const index = manifest.parts.findIndex((part) => `${dir}${part}` === path);
    if (index >= 0) {
      return Promise.resolve(
        new Response(file.slice(index * 3, index * 3 + 3)),
      );
    }
    return Promise.resolve(new Response(null, { status: 404 }));
  };
}

/** The pin for `file`: its one sha256 (the site serves it in 3-byte
 * parts, transport only). */
async function pinFor(file: Uint8Array): Promise<SnapshotPin> {
  return {
    releaseRepo: "YurtOS/yurt-playground",
    format: FORMAT,
    release: "snapshot-test",
    sha256: await sha256Hex(file),
    size: file.byteLength,
    builtFrom: BUILT,
    memoryBytes: memoryOf(file),
  };
}

/** The kernel memory a snapshot zip's manifest names (16 for a file
 * that is no snapshot zip). */
function memoryOf(file: Uint8Array): number {
  // The stored manifest is the first entry: its JSON starts after the
  // 30-byte local header and the name.
  try {
    const view = new DataView(file.buffer, file.byteOffset);
    const start = 30 + view.getUint16(26, true);
    const json = new TextDecoder().decode(
      file.subarray(start, start + view.getUint32(18, true)),
    );
    return JSON.parse(json).memoryBytes ?? 16;
  } catch {
    return 16;
  }
}

/** How many 3-byte parts {@link site} serves `file` in. */
const partsOf = (file: Uint8Array) => Math.ceil(file.byteLength / 3);

Deno.test("the downloaded snapshot is hashed whole, part by part as it arrives, against the pin", async () => {
  const sealed = image(1 << 10);
  const file = new Uint8Array(
    await (await encodeSandboxSnapshot(sealed, BUILT)).arrayBuffer(),
  );
  const name = "snapshot/sandbox.seal.zip";
  const path = `http://pg/${name}`;
  const pin = await pinFor(file);
  const progress: number[] = [];
  assertEquals(
    await decodeSandboxSnapshot(
      await fetchVerifiedSnapshot(
        path,
        pin,
        site(name, file),
        (loaded, total) => {
          assertEquals(total, file.byteLength);
          progress.push(loaded);
        },
      ),
      BUILT,
    ),
    sealed,
  );
  assertEquals(progress.length, partsOf(file), "one report per part");
  assertEquals(progress.at(-1), file.byteLength);
  // One byte off in the zip's trailer: every entry reads; the hash fails.
  const damaged = file.slice();
  damaged[damaged.byteLength - 20] ^= 0xff;
  await assertRejects(
    async () =>
      await decodeSandboxSnapshot(
        await fetchVerifiedSnapshot(path, pin, site(name, damaged)),
        BUILT,
      ),
    Error,
    `not the pinned ${file.byteLength} bytes with ${pin.sha256}`,
  );
  await assertRejects(
    () => fetchVerifiedSnapshot(path, pin, site(name, file.slice(0, -3))),
    Error,
    "not the pinned",
  );
});

Deno.test("only a snapshot pinned for the site's own kernel, image and Python set is used", () => {
  const pin = (sha256: string) => ({
    repo: "r",
    rev: "v",
    build: "b",
    path: "p",
    sha256,
  });
  const pins = {
    kernelWasm: { ...pin(BUILT.kernelSha256), rev: BUILT.kernelRev },
    image: pin("full"),
    browserImage: pin(BUILT.imageSha256),
    pythonSeal: { sha256: BUILT.pythonSealSha256! },
  };
  const snapshot: SnapshotPin = {
    releaseRepo: "r",
    format: FORMAT,
    release: "t",
    sha256: "00".repeat(32),
    size: 1,
    builtFrom: BUILT,
    memoryBytes: 16,
  };
  assertEquals(pinnedSnapshot({ ...pins, snapshot }), snapshot);
  assertThrows(() => pinnedSnapshot(pins), SnapshotMismatch, "pins no");
  assertThrows(
    () =>
      pinnedSnapshot({
        ...pins,
        snapshot: {
          ...snapshot,
          builtFrom: { ...BUILT, imageSha256: "11".repeat(32) },
        },
      }),
    SnapshotMismatch,
    `pinned snapshot was built from imageSha256 ${"11".repeat(32)}`,
  );
});

Deno.test("a malformed snapshot entry never breaks the pins, and is refused where it is used", async () => {
  const raw = JSON.parse(
    await Deno.readTextFile(new URL("../artifacts/pins.json", import.meta.url)),
  );
  const pins = parsePins({ ...raw, snapshot: undefined });
  const snapshot = {
    releaseRepo: "YurtOS/yurt-playground",
    format: FORMAT,
    release: "snapshot-x",
    sha256: "aa".repeat(32),
    size: 10,
    builtFrom: { ...snapshotIdentity(pins), pythonSet: null },
    memoryBytes: 16,
  };
  assertEquals(pinnedSnapshot({ ...pins, snapshot }), snapshot);
  for (
    const bad of [
      { ...snapshot, store: { identity: {} } },
      { ...snapshot, sha256: "AA".repeat(32) },
      { ...snapshot, size: 0 },
      { ...snapshot, builtFrom: { kernelSha256: BUILT.kernelSha256 } },
      "an older shape",
    ]
  ) {
    // The default boot and the deploy read the pins: they still parse.
    const parsed = parsePins({ ...raw, snapshot: bad });
    assertThrows(
      () => pinnedSnapshot(parsed),
      SnapshotMismatch,
      "the pinned snapshot entry is malformed",
    );
  }
});

Deno.test("a snapshot of another Python set than the live index offers is not restored", () => {
  checkPythonSet(BUILT, BUILT.pythonSet);
  // The index could not be asked: the snapshot, as a stored layer offline.
  checkPythonSet(BUILT, undefined);
  assertThrows(
    () => checkPythonSet(BUILT, "cd/python@3.14.8-yurt_1:fedcba9876543210"),
    SnapshotMismatch,
    "the live index offers cd/python@3.14.8",
  );
  // No request at all is the page's, not the index's: said so.
  assertThrows(
    () => checkPythonSet(BUILT, null),
    SnapshotMismatch,
    "this page installs no Python (a phone, a shell-only session, or no pins)",
  );
  // A phone's snapshot (?snapshot=capture-phone) holds no set: a page
  // that installs none restores it, and only such a page.
  checkPythonSet({ ...BUILT, pythonSet: null }, null);
  assertThrows(
    () => checkPythonSet({ ...BUILT, pythonSet: null }, "img/python@1"),
    SnapshotMismatch,
    "the snapshot holds no Python set, the live index offers img/python@1",
  );
});

Deno.test("a snapshot header of another format is refused", async () => {
  const file = await rawSnapshot({
    format: 5,
    builtFrom: BUILT,
    memoryBytes: 16,
  }, new Uint8Array(16));
  await assertRejects(
    () => decodeSandboxSnapshot(file.stream(), BUILT),
    SnapshotMismatch,
    "format 5, not 4",
  );
  await assertRejects(
    () => checkSandboxSnapshot(file.stream(), BUILT),
    SnapshotMismatch,
    "format 5",
  );
});

Deno.test("?snapshot=1 boots the image when the snapshot cannot be had, whatever the reason", async () => {
  const name = "snapshot/sandbox.seal.zip";
  const path = `http://pg/${name}`;
  const good = new Uint8Array(
    await (await encodeSandboxSnapshot(image(1 << 10), BUILT)).arrayBuffer(),
  );
  const truncated = good.slice(0, good.byteLength - 10);
  const notZip = new TextEncoder().encode("<html>not a snapshot</html>");
  const damaged = good.slice();
  damaged[damaged.byteLength - 20] ^= 0xff;
  const pin = await pinFor(good);
  const other = new Uint8Array(
    await (await encodeSandboxSnapshot(image(16), {
      ...BUILT,
      kernelSha256: "00".repeat(32),
    })).arrayBuffer(),
  );
  /** The restore `?snapshot=1` makes: the pinned file, served by `serve`. */
  const restoreFrom = (served: typeof fetch, pinned: SnapshotPin) => () =>
    fetchVerifiedSnapshot(path, pinned, served).then((body) =>
      decodeSandboxSnapshot(body, BUILT)
    );
  const notFound: typeof fetch = () =>
    Promise.resolve(new Response(null, { status: 404 }));
  const cases: [string, () => Promise<unknown>][] = [
    ["no parts.json", restoreFrom(notFound, pin)],
    [
      "a part 404s",
      restoreFrom((input) => {
        return String(input).endsWith(".parts.json")
          ? site(name, good)(input)
          : notFound(input);
      }, pin),
    ],
    ["a different size", restoreFrom(site(name, good.slice(0, -3)), pin)],
    [
      "bytes that are not the pinned ones",
      restoreFrom(site(name, damaged), pin),
    ],
    ["truncated", restoreFrom(site(name, truncated), await pinFor(truncated))],
    ["not a zip", restoreFrom(site(name, notZip), await pinFor(notZip))],
    ["another build", restoreFrom(site(name, other), await pinFor(other))],
  ];
  const warn = console.warn;
  const warned: string[] = [];
  console.warn = (...args: unknown[]) => warned.push(args.join(" "));
  try {
    for (const [why, restore] of cases) {
      assertEquals(
        await snapshotOrBoot(restore, () => Promise.resolve("booted")),
        { kernel: "booted", restored: false },
        why,
      );
    }
    assertEquals(warned.length, cases.length, "each fallback is noted");
    assertEquals(
      (await snapshotOrBoot(
        restoreFrom(site(name, good), pin),
        () => Promise.reject(new Error("not booted")),
      )).restored,
      true,
    );
  } finally {
    console.warn = warn;
  }
});

Deno.test("a pin of another snapshot format is not used", () => {
  const pin = (sha256: string) => ({
    repo: "r",
    rev: BUILT.kernelRev,
    build: "b",
    path: "p",
    sha256,
  });
  const pins = {
    kernelWasm: pin(BUILT.kernelSha256),
    image: pin("full"),
    browserImage: pin(BUILT.imageSha256),
    pythonSeal: { sha256: BUILT.pythonSealSha256! },
  };
  const snapshot = {
    releaseRepo: "r",
    release: "t",
    format: 2,
    sha256: "00".repeat(32),
    size: 1,
    builtFrom: BUILT,
  };
  assertThrows(
    () => pinnedSnapshot({ ...pins, snapshot }),
    SnapshotMismatch,
    "format 2, not 4",
  );
});

Deno.test("a snapshot of another Python set is refused, with the download beside the check, and never restored", async () => {
  // A pin built for these pins here, not the committed entry: a train
  // may drop that one.
  const raw = JSON.parse(
    await Deno.readTextFile(new URL("../artifacts/pins.json", import.meta.url)),
  );
  const unpinned = parsePins({ ...raw, snapshot: undefined });
  const built = { ...snapshotIdentity(unpinned), pythonSet: BUILT.pythonSet };
  const file = new Uint8Array(
    await (await encodeSandboxSnapshot(image(1 << 10), built)).arrayBuffer(),
  );
  const pin = { ...await pinFor(file), builtFrom: built };
  const name = "snapshot/sandbox.seal.zip";
  const served = site(name, file);
  const pinsText = JSON.stringify({ ...raw, snapshot: pin });
  const fetched: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    fetched.push(url);
    return url.endsWith("pins.json")
      ? Promise.resolve(new Response(pinsText))
      : served(url, init);
  }) as typeof fetch;
  try {
    for (const delayMs of [0, 50]) {
      fetched.length = 0;
      await assertRejects(
        () =>
          restoreSnapshot(
            {
              isolated: true,
              fetchBytes: () => Promise.reject(new Error("not in this test")),
              show: () => {},
              term: {} as never,
              // The index answers before or after the download is done.
              livePythonSet: () =>
                new Promise((resolve) =>
                  setTimeout(
                    () => resolve("a set the snapshot does not hold"),
                    delayMs,
                  )
                ),
            },
            // Not a kernel: a restore that went ahead would fail on it
            // with another error.
            new Uint8Array(),
            `http://pg/${name}`,
          ),
        SnapshotMismatch,
        "the live index offers a set the snapshot does not hold",
      );
      // The download ran beside the check: it is not on the critical path.
      assertEquals(
        fetched.some((url) => url.includes("snapshot/")),
        true,
        `delay ${delayMs}`,
      );
    }
  } finally {
    globalThis.fetch = realFetch;
  }
});

/** A CacheStorage that keeps everything in memory. */
function memoryCaches(): CacheStorage & {
  store: Map<string, Uint8Array>;
  deleted: string[];
} {
  const store = new Map<string, Uint8Array>();
  // Kept beside the bodies, as the Cache API keeps a response's headers.
  const headers = new Map<string, Headers>();
  const deleted: string[] = [];
  const cache = {
    match: (key: string) =>
      Promise.resolve(
        store.has(key)
          ? new Response(store.get(key)!.slice(), { headers: headers.get(key) })
          : undefined,
      ),
    put: async (key: string, response: Response) => {
      headers.set(key, response.headers);
      store.set(key, new Uint8Array(await response.arrayBuffer()));
    },
    delete: (key: string | Request) =>
      Promise.resolve(store.delete(typeof key === "string" ? key : key.url)),
    keys: () =>
      Promise.resolve([...store.keys()].map((url) => new Request(url))),
  };
  return {
    store,
    deleted,
    open: () => Promise.resolve(cache as unknown as Cache),
    delete: (name: string) => {
      deleted.push(name);
      return Promise.resolve(false);
    },
  } as unknown as CacheStorage & {
    store: Map<string, Uint8Array>;
    deleted: string[];
  };
}

Deno.test("parts of a zip never verified whole are never taken from the cache", async () => {
  const sealed = image(1 << 10);
  const file = new Uint8Array(
    await (await encodeSandboxSnapshot(sealed, BUILT)).arrayBuffer(),
  );
  const name = "snapshot/tablet.seal.zip";
  const path = `http://pg/${name}`;
  const pin = await pinFor(file);
  // An HTML fallback where a part of the manifest belongs: the decode
  // fails on it long before the stream's end and its hash.
  const bad = file.slice();
  bad.set(new TextEncoder().encode("<ht"), 45);
  const restore = (served: Uint8Array<ArrayBuffer>, cache: CacheStorage) =>
    fetchVerifiedSnapshot(path, pin, site(name, served), undefined, cache)
      .then((body) => decodeSandboxSnapshot(body, BUILT));
  const failed = memoryCaches();
  await assertRejects(() => restore(bad, failed));
  assertEquals(await restore(file, failed), sealed, "after a failed decode");
  // A visit left before its end (a closed tab: nothing cancels it).
  const left = memoryCaches();
  const reader = (await fetchVerifiedSnapshot(
    path,
    pin,
    site(name, bad),
    undefined,
    left,
  )).getReader();
  for (let i = 0; i < 20; i++) await reader.read();
  assertEquals(await restore(file, left), sealed, "after a visit left");
});

Deno.test("a verified cache outlives a visit that stops for another reason than its bytes", async () => {
  const sealed = image(1 << 10);
  const file = new Uint8Array(
    await (await encodeSandboxSnapshot(sealed, BUILT)).arrayBuffer(),
  );
  const name = "snapshot/tablet.seal.zip";
  const path = `http://pg/${name}`;
  const pin = await pinFor(file);
  const served = site(name, file);
  let partFetches = 0;
  const counting: typeof fetch = (input, init) => {
    if (!String(input).endsWith(".parts.json")) partFetches++;
    return served(input, init);
  };
  const cache = memoryCaches();
  const restore = (beforeAllocate?: () => Promise<void>) =>
    fetchVerifiedSnapshot(path, pin, counting, undefined, cache).then((
      body,
    ) => decodeSandboxSnapshot(body, BUILT, undefined, beforeAllocate));
  assertEquals(await restore(), sealed);
  // The live index refuses its Python set: the download is cancelled.
  await assertRejects(
    () => restore(() => Promise.reject(new SnapshotMismatch("another set"))),
    SnapshotMismatch,
  );
  partFetches = 0;
  assertEquals(await restore(), sealed);
  assertEquals(partFetches, 0, "the verified parts were kept");
});

Deno.test("a damaged part in a verified cache is fetched again, not used", async () => {
  const sealed = image(1 << 10);
  const file = new Uint8Array(
    await (await encodeSandboxSnapshot(sealed, BUILT)).arrayBuffer(),
  );
  const name = "snapshot/tablet.seal.zip";
  const path = `http://pg/${name}`;
  const pin = await pinFor(file);
  const cache = memoryCaches();
  const restore = () =>
    fetchVerifiedSnapshot(path, pin, site(name, file), undefined, cache)
      .then((body) => decodeSandboxSnapshot(body, BUILT));
  assertEquals(await restore(), sealed);
  // The cached part holding the manifest's name goes bad: the decode would stop on it
  // long before the stream's end and its hash.
  const key = [...cache.store.keys()].find((url) => url.endsWith("/14"))!;
  cache.store.set(key, new TextEncoder().encode("<ht"));
  assertEquals(await restore(), sealed);
});

Deno.test("parts are cached by their layout's part size, and other layouts of the zip are dropped", async () => {
  const sealed = image(1 << 10);
  const file = new Uint8Array(
    await (await encodeSandboxSnapshot(sealed, BUILT)).arrayBuffer(),
  );
  const name = "snapshot/tablet.seal.zip";
  const pin = await pinFor(file);
  const cache = memoryCaches();
  const origin = "https://yurt-snapshot-parts.invalid/";
  // A part of this very zip in another layout, from an earlier deploy.
  const stale = `${origin}${pin.sha256}/4/0`;
  cache.store.set(stale, new Uint8Array([1]));
  assertEquals(
    await fetchVerifiedSnapshot(
      `http://pg/${name}`,
      pin,
      site(name, file),
      undefined,
      cache,
    ).then((body) => decodeSandboxSnapshot(body, BUILT)),
    sealed,
  );
  assertEquals(cache.store.has(stale), false, "the other layout's part");
  assert(
    [...cache.store.keys()].some((url) =>
      url.startsWith(`${origin}${pin.sha256}/3/`)
    ),
  );
});

Deno.test("a part whose fetch finishes after its visit stopped is not left in the cache", async () => {
  const sealed = image(1 << 10);
  const file = new Uint8Array(
    await (await encodeSandboxSnapshot(sealed, BUILT)).arrayBuffer(),
  );
  const name = "snapshot/tablet.seal.zip";
  const served = site(name, file);
  let slow: () => void = () => {};
  const late = new Promise<void>((resolve) => slow = resolve);
  // Part 1 fails at once while part 2 is still on its way.
  const fetching: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith(".1")) return new Response(null, { status: 500 });
    if (url.endsWith(".2")) await late;
    return served(input, init);
  };
  const cache = memoryCaches();
  await assertRejects(() =>
    fetchVerifiedSnapshot(
      `http://pg/${name}`,
      { sha256: "ab".repeat(32), size: file.byteLength },
      fetching,
      undefined,
      cache,
    ).then((body) => decodeSandboxSnapshot(body, BUILT))
  );
  slow();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assertEquals([...cache.store.keys()], []);
});

Deno.test("a gzip of before the zip is refused with the format's own advice", async () => {
  const gzip = await new Response(
    new Blob([new Uint8Array(64)]).stream().pipeThrough(
      new CompressionStream("gzip"),
    ),
  ).blob();
  await assertRejects(
    () => decodeSandboxSnapshot(gzip.stream(), BUILT),
    SnapshotMismatch,
    "format 3, not 4: a gzip of the kernel memory, from before the zip",
  );
});

Deno.test("a restore drops the gzip snapshot's part cache", async () => {
  const sealed = image(16);
  const file = new Uint8Array(
    await (await encodeSandboxSnapshot(sealed, BUILT)).arrayBuffer(),
  );
  const name = "snapshot/sandbox.seal.zip";
  const caches = memoryCaches();
  await fetchVerifiedSnapshot(
    `http://pg/${name}`,
    await pinFor(file),
    site(name, file),
    undefined,
    caches,
  ).then((body) => decodeSandboxSnapshot(body, BUILT));
  assertEquals(caches.deleted, ["yurt-playground-snapshot-parts-v1"]);
});

Deno.test("a repeat restore takes the parts from the cache, drops them when the zip fails its hash, and drops other snapshots' parts", async () => {
  const sealed = image(1 << 10);
  const file = new Uint8Array(
    await (await encodeSandboxSnapshot(sealed, BUILT)).arrayBuffer(),
  );
  const name = "snapshot/tablet.seal.zip";
  const path = `http://pg/${name}`;
  const pin = await pinFor(file);
  const served = site(name, file);
  let partFetches = 0;
  const counting: typeof fetch = (input, init) => {
    if (!String(input).endsWith(".parts.json")) partFetches++;
    return served(input, init);
  };
  const cache = memoryCaches();
  const origin = "https://yurt-snapshot-parts.invalid/";
  const foreign = `${origin}${"0".repeat(64)}/0`;
  cache.store.set(foreign, new Uint8Array([1]));
  const restore = () =>
    fetchVerifiedSnapshot(path, pin, counting, undefined, cache).then((
      body,
    ) => decodeSandboxSnapshot(body, BUILT));
  assertEquals(await restore(), sealed);
  assertEquals(partFetches, partsOf(file), "the first visit downloads");
  assertEquals(cache.store.has(foreign), false, "another snapshot's part");
  // Every part, and the mark that the whole passed its hash.
  assertEquals(cache.store.size, partsOf(file) + 1);
  assertEquals(cache.store.has(`${origin}${pin.sha256}/verified`), true);
  partFetches = 0;
  assertEquals(await restore(), sealed);
  assertEquals(partFetches, 0, "a repeat visit downloads no part");
  // A cached part that is not the bytes it was put as is fetched again.
  const last = `${origin}${pin.sha256}/3/${partsOf(file) - 1}`;
  cache.store.set(last, new Uint8Array([9]));
  partFetches = 0;
  assertEquals(await restore(), sealed);
  assertEquals(partFetches, 1, "only the damaged part");
  // One of the right length but other bytes is fetched again too: the
  // marker holds each verified part's sha256. The length is the real last
  // part's, which depends on the platform's deflate (685 bytes on macOS,
  // 680 on Linux).
  const wrong = file.slice((partsOf(file) - 1) * 3);
  wrong[0] ^= 0xff;
  cache.store.set(last, wrong);
  partFetches = 0;
  assertEquals(await restore(), sealed);
  assertEquals(partFetches, 1, "only the part that is not the verified one");
  // A download that fails the whole zip's hash (the site serves a bad
  // last part, which this visit fetches) is refused, the page boots
  // instead, and all of this zip's parts are fetched afresh after.
  cache.store.delete(last);
  const bad = file.slice();
  bad[bad.byteLength - 1] ^= 0xff;
  const badSite = site(name, bad);
  const fromBad = () =>
    fetchVerifiedSnapshot(path, pin, badSite, undefined, cache)
      .then((body) => decodeSandboxSnapshot(body, BUILT));
  await assertRejects(fromBad, Error, "not the pinned");
  assertEquals(cache.store.size, 0, "this zip's parts are dropped");
  partFetches = 0;
  assertEquals(await restore(), sealed);
  assertEquals(partFetches, partsOf(file));
});

Deno.test("each device's snapshot is its own pins.json entry", async () => {
  const raw = JSON.parse(
    await Deno.readTextFile(new URL("../artifacts/pins.json", import.meta.url)),
  );
  const pins = parsePins({
    ...raw,
    snapshot: undefined,
    tabletSnapshot: undefined,
    phoneSnapshot: undefined,
  });
  const entry = (pythonSet: string | null) => ({
    releaseRepo: "YurtOS/yurt-playground",
    release: "snapshot-x",
    format: FORMAT,
    sha256: "a".repeat(64),
    size: 1,
    builtFrom: { ...snapshotIdentity(pins), pythonSet },
    memoryBytes: 4096,
    contents: {
      packages: [{ name: "git", version: "2.55.0", build: "yurt_0" }],
      remark: "BusyBox shell, git 2.55.0; no Python, no Jupyter",
    },
  });
  const all = {
    ...pins,
    snapshot: entry("set"),
    tabletSnapshot: entry("python"),
    phoneSnapshot: entry(null),
  };
  assertEquals(pinnedSnapshot(all).builtFrom.pythonSet, "set");
  assertEquals(pinnedSnapshot(all, "tablet").builtFrom.pythonSet, "python");
  assertEquals(pinnedSnapshot(all, "phone").builtFrom.pythonSet, null);
  assertEquals(pinnedSnapshot(all, "phone").memoryBytes, 4096);
  assertEquals(
    pinnedSnapshot(all, "phone").contents?.remark,
    "BusyBox shell, git 2.55.0; no Python, no Jupyter",
  );
  assertThrows(
    () => pinnedSnapshot({ ...pins, snapshot: entry("set") }, "phone"),
    SnapshotMismatch,
    "the site pins no phone snapshot (phoneSnapshot)",
  );
  assertThrows(
    () =>
      pinnedSnapshot(
        { ...pins, tabletSnapshot: { ...entry("p"), contents: { remark: 1 } } },
        "tablet",
      ),
    SnapshotMismatch,
    "contents must be",
  );
});

Deno.test("a snapshot's header records what it holds, read without its memory", async () => {
  const contents = {
    packages: [{ name: "python", version: "3.14.7", build: "yurt_0" }],
    remark: "BusyBox shell, Python 3.14.7; no Jupyter",
  };
  const blob = await encodeSandboxSnapshot(image(1 << 12), BUILT, contents);
  assertEquals(
    await snapshotHeaderFacts(
      blob.stream() as ReadableStream<Uint8Array<ArrayBuffer>>,
    ),
    { format: FORMAT, memoryBytes: 1 << 12, contents },
  );
  // And the decode is the same seal as without them.
  assertEquals(
    await decodeSandboxSnapshot(
      blob.stream() as ReadableStream<Uint8Array<ArrayBuffer>>,
      BUILT,
    ),
    image(1 << 12),
  );
});

Deno.test("a manifest that names no memory size is refused as such", async () => {
  for (const memoryBytes of [undefined, -1, 1.5, "16"]) {
    const file = await rawSnapshot(
      { format: FORMAT, builtFrom: BUILT, memoryBytes },
      new Uint8Array(16),
    );
    await assertRejects(
      () => decodeSandboxSnapshot(file.stream(), BUILT),
      SnapshotMismatch,
      "names no memoryBytes",
    );
  }
});

Deno.test("a check still pending refuses the snapshot before its memory is allocated", async () => {
  // More memory than any allocation gets: allocating it would throw a
  // RangeError, so the gate's own refusal shows it came first.
  const file = await rawSnapshot({
    format: FORMAT,
    builtFrom: BUILT,
    memoryBytes: 2 ** 52,
  });
  let headerSeen = false;
  await assertRejects(
    () =>
      decodeSandboxSnapshot(
        file.stream(),
        BUILT,
        () => headerSeen = true,
        () =>
          Promise.reject(
            new SnapshotMismatch("the live index offers another set"),
          ),
      ),
    SnapshotMismatch,
    "the live index offers another set",
  );
  assertEquals(headerSeen, true, "the header was read and accepted first");
});

Deno.test("a download is the pin's: a parts list of another layout is refused before any part, and a part of another length when it comes", async () => {
  const file = new Uint8Array(
    await (await encodeSandboxSnapshot(image(1 << 10), BUILT)).arrayBuffer(),
  );
  const name = "snapshot/tablet.seal.zip";
  const path = `http://pg/${name}`;
  const pin = await pinFor(file);
  const served = site(name, file);
  const manifest = JSON.parse(
    await (await served(`http://pg/${name}.parts.json`)).text(),
  );
  for (
    const listed of [
      // A stale list with one part too many (its size still the pin's).
      { ...manifest, parts: [...manifest.parts, `${name}.x`] },
      // Parts bigger than the page ever slices.
      { ...manifest, partBytes: IMAGE_PART_BYTES + 1, parts: ["a"] },
      { ...manifest, partBytes: undefined },
    ]
  ) {
    let partFetches = 0;
    const lying: typeof fetch = (input, init) => {
      if (String(input).endsWith(".parts.json")) {
        return Promise.resolve(new Response(JSON.stringify(listed)));
      }
      partFetches++;
      return served(input, init);
    };
    await assertRejects(
      () => fetchVerifiedSnapshot(path, pin, lying),
      Error,
      "not a layout of its pinned",
    );
    assertEquals(partFetches, 0);
  }
  // A part longer than its place in the layout stops the stream there.
  const long: typeof fetch = async (input, init) => {
    const response = await served(input, init);
    if (!String(input).endsWith(".2")) return response;
    return new Response(new Uint8Array([1, 2, 3, 4]));
  };
  await assertRejects(
    () =>
      fetchVerifiedSnapshot(path, pin, long).then((body) =>
        new Response(body).arrayBuffer()
      ),
    Error,
    "is 4 bytes, not its 3",
  );
});

Deno.test("a part another visit put is never taken unless it is the verified bytes, whenever and by whom it was put", async () => {
  const sealed = image(1 << 10);
  const file = new Uint8Array(
    await (await encodeSandboxSnapshot(sealed, BUILT)).arrayBuffer(),
  );
  const name = "snapshot/tablet.seal.zip";
  const path = `http://pg/${name}`;
  const pin = await pinFor(file);
  const cache = memoryCaches();
  let partFetches = 0;
  const served = site(name, file);
  const counting: typeof fetch = (input, init) => {
    if (!String(input).endsWith(".parts.json")) partFetches++;
    return served(input, init);
  };
  const restore = () =>
    fetchVerifiedSnapshot(path, pin, counting, undefined, cache)
      .then((body) => decodeSandboxSnapshot(body, BUILT));
  assertEquals(await restore(), sealed);
  const verified = [...cache.store.keys()].find((url) =>
    url.endsWith("/verified")
  )!;
  // Part 14 (inside the manifest) goes missing. Another visit -- another
  // tab, while this cache is verified -- fetches it from another deploy
  // (the same name, the same length, other bytes) and is left (a closed
  // tab: nothing cancels it, nothing drops what it put).
  const key = [...cache.store.keys()].find((url) => url.endsWith("/14"))!;
  cache.store.delete(key);
  const other = file.slice();
  other[43] = "X".charCodeAt(0);
  const reader = (await fetchVerifiedSnapshot(
    path,
    pin,
    site(name, other),
    undefined,
    cache,
  )).getReader();
  for (let i = 0; i < 20; i++) await reader.read();
  assert(cache.store.has(key), "the other deploy's part was put");
  assert(cache.store.has(verified), "under a verified marker");
  // It is not the bytes the marker verified: the next visit fetches it
  // again (that one part) and restores, as does every visit after.
  for (const visit of [1, 2]) {
    partFetches = 0;
    assertEquals(await restore(), sealed, `visit ${visit}`);
    assertEquals(partFetches, visit === 1 ? 1 : 0, `visit ${visit}`);
  }
  await reader.cancel();
});

Deno.test("a cached part of another length than its place is fetched again, not used", async () => {
  const sealed = image(1 << 10);
  const file = new Uint8Array(
    await (await encodeSandboxSnapshot(sealed, BUILT)).arrayBuffer(),
  );
  const name = "snapshot/tablet.seal.zip";
  const path = `http://pg/${name}`;
  const pin = await pinFor(file);
  const cache = memoryCaches();
  const restore = () =>
    fetchVerifiedSnapshot(path, pin, site(name, file), undefined, cache)
      .then((body) => decodeSandboxSnapshot(body, BUILT));
  assertEquals(await restore(), sealed);
  // Under part 14's key, the bytes of another slicing of this very zip
  // (4 bytes from its offset): not this layout's part.
  const key = [...cache.store.keys()].find((url) => url.endsWith("/14"))!;
  cache.store.set(key, file.slice(14 * 3, 14 * 3 + 4));
  assertEquals(await restore(), sealed);
});
