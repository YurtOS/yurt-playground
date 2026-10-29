import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import type { SandboxSealImage } from "@yurt/kernel-host-interface-js";
import { restoreSnapshot, snapshotOrBoot } from "../src/boot.ts";
import { sha256Hex } from "../src/integrity.ts";
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

const BUILT: BuiltFrom = {
  kernelSha256: "ab".repeat(32),
  kernelRev: "3d32068f59dcbbffd1aa7a9482e6b5e6f75472b1",
  sealVersion: 1,
  bootSetup: BOOT_SETUP,
  imageSha256: "cd".repeat(32),
  pythonSealSha256: "ef".repeat(32),
  pythonSet: "cd/python@3.14.7-yurt_0:0123456789abcdef",
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

Deno.test("a sandbox snapshot built from anything else is refused, by name", async () => {
  const file = await encodeSandboxSnapshot(image(4096), BUILT);
  const others: Partial<BuiltFrom> = {
    pythonSet: "cd/python@3.14.8-yurt_0:fedcba9876543210",
    kernelSha256: "00".repeat(32),
    kernelRev: "0000000",
    sealVersion: 2,
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
    format: 3,
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

/** The pin for `file` split in 3-byte parts. */
async function pinFor(file: Uint8Array): Promise<SnapshotPin> {
  const parts: string[] = [];
  for (let i = 0; i < file.byteLength; i += 3) {
    parts.push(await sha256Hex(file.slice(i, i + 3)));
  }
  return {
    releaseRepo: "YurtOS/yurt-playground",
    format: 3,
    release: "snapshot-test",
    sha256: await sha256Hex(file),
    size: file.byteLength,
    parts,
    builtFrom: BUILT,
  };
}

Deno.test("the downloaded snapshot is checked part by part against the pin", async () => {
  const sealed = image(1 << 10);
  const file = new Uint8Array(
    await (await encodeSandboxSnapshot(sealed, BUILT)).arrayBuffer(),
  );
  const name = "snapshot/sandbox.seal.gz";
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
  assertEquals(progress.length, pin.parts.length, "one report per part");
  assertEquals(progress.at(-1), file.byteLength);
  const damaged = file.slice();
  damaged[damaged.byteLength - 20] ^= 0xff;
  await assertRejects(
    async () =>
      await decodeSandboxSnapshot(
        await fetchVerifiedSnapshot(path, pin, site(name, damaged)),
        BUILT,
      ),
    Error,
    "sha256 mismatch",
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
    format: 3,
    release: "t",
    sha256: "00".repeat(32),
    size: 1,
    parts: ["00".repeat(32)],
    builtFrom: BUILT,
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
    format: 3,
    release: "snapshot-x",
    sha256: "aa".repeat(32),
    size: 10,
    parts: ["bb".repeat(32)],
    builtFrom: { ...snapshotIdentity(pins), pythonSet: null },
  };
  assertEquals(pinnedSnapshot({ ...pins, snapshot }), snapshot);
  for (
    const bad of [
      { ...snapshot, parts: [] },
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
    format: 4,
    builtFrom: BUILT,
    memoryBytes: 16,
  }, new Uint8Array(16));
  await assertRejects(
    () => decodeSandboxSnapshot(file.stream(), BUILT),
    SnapshotMismatch,
    "format 4, not 3",
  );
  await assertRejects(
    () => checkSandboxSnapshot(file.stream(), BUILT),
    SnapshotMismatch,
    "format 4",
  );
});

Deno.test("?snapshot=1 boots the image when the snapshot cannot be had, whatever the reason", async () => {
  const name = "snapshot/sandbox.seal.gz";
  const path = `http://pg/${name}`;
  const good = new Uint8Array(
    await (await encodeSandboxSnapshot(image(1 << 10), BUILT)).arrayBuffer(),
  );
  const raw = new Uint8Array(
    await new Response(
      new Blob([good]).stream().pipeThrough(new DecompressionStream("gzip")),
    ).arrayBuffer(),
  );
  const truncated = new Uint8Array(
    await new Response(
      new Blob([raw.subarray(0, raw.byteLength - 10)]).stream().pipeThrough(
        new CompressionStream("gzip"),
      ),
    ).arrayBuffer(),
  );
  const notGzip = new TextEncoder().encode("<html>not a snapshot</html>");
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
      "a part that is not the pinned one",
      restoreFrom(site(name, damaged), pin),
    ],
    ["truncated", restoreFrom(site(name, truncated), await pinFor(truncated))],
    ["not gzip", restoreFrom(site(name, notGzip), await pinFor(notGzip))],
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
    parts: ["00".repeat(32)],
    builtFrom: BUILT,
  };
  assertThrows(
    () => pinnedSnapshot({ ...pins, snapshot }),
    SnapshotMismatch,
    "format 2, not 3",
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
  const name = "snapshot/sandbox.seal.gz";
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
function memoryCaches(): CacheStorage & { store: Map<string, Uint8Array> } {
  const store = new Map<string, Uint8Array>();
  const cache = {
    match: (key: string) =>
      Promise.resolve(
        store.has(key) ? new Response(store.get(key)!.slice()) : undefined,
      ),
    put: async (key: string, response: Response) => {
      store.set(key, new Uint8Array(await response.arrayBuffer()));
    },
    delete: (key: string | Request) =>
      Promise.resolve(store.delete(typeof key === "string" ? key : key.url)),
    keys: () =>
      Promise.resolve([...store.keys()].map((url) => new Request(url))),
  };
  return {
    store,
    open: () => Promise.resolve(cache as unknown as Cache),
  } as unknown as CacheStorage & { store: Map<string, Uint8Array> };
}

Deno.test("a repeat restore takes the checked parts from the cache, and drops other snapshots' parts", async () => {
  const sealed = image(1 << 10);
  const file = new Uint8Array(
    await (await encodeSandboxSnapshot(sealed, BUILT)).arrayBuffer(),
  );
  const name = "snapshot/tablet.seal.gz";
  const path = `http://pg/${name}`;
  const pin = await pinFor(file);
  const served = site(name, file);
  let partFetches = 0;
  const counting: typeof fetch = (input, init) => {
    if (!String(input).endsWith(".parts.json")) partFetches++;
    return served(input, init);
  };
  const cache = memoryCaches();
  const foreign = `https://yurt-snapshot-parts.invalid/${"0".repeat(64)}`;
  cache.store.set(foreign, new Uint8Array([1]));
  const restore = () =>
    fetchVerifiedSnapshot(path, pin, counting, undefined, cache).then((
      body,
    ) => decodeSandboxSnapshot(body, BUILT));
  assertEquals(await restore(), sealed);
  // Each part with a sha256 not yet held (this test's 3-byte parts
  // repeat; a real snapshot's do not).
  assert(
    partFetches >= new Set(pin.parts).size && partFetches <= pin.parts.length,
    `the first visit downloads: ${partFetches}`,
  );
  assertEquals(cache.store.has(foreign), false, "another snapshot's part");
  assertEquals(cache.store.size, new Set(pin.parts).size);
  partFetches = 0;
  assertEquals(await restore(), sealed);
  assertEquals(partFetches, 0, "a repeat visit downloads no part");
  // A damaged cached part is fetched again, never used.
  const first = `https://yurt-snapshot-parts.invalid/${pin.parts[0]}`;
  cache.store.set(first, new Uint8Array([9, 9, 9]));
  partFetches = 0;
  assertEquals(await restore(), sealed);
  assertEquals(partFetches > 0, true);
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
    parts: ["b".repeat(64)],
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
    { memoryBytes: 1 << 12, contents },
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
