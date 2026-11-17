import { assert, assertEquals, assertRejects } from "@std/assert";
import type { SandboxSealImage } from "@yurt/kernel-host-interface-js";
import type { Pins } from "../src/pins.ts";
import { writeZip } from "../src/snapshot_zip.ts";
import { FORMAT } from "../src/sandbox_snapshot.ts";
import {
  decodeLoadedSnapshot,
  LOAD_MEMORY_MAX_BYTES,
  LOAD_MEMORY_MAX_SMALL_BYTES,
  LoadRefused,
  loadSandbox,
  memoryRefusal,
  type ReplaceOutcome,
  type SandboxFileDeps,
  type SandboxFileMessage,
  sandboxFileOk,
  savedBuiltFrom,
  savedFileName,
  saveSandbox,
  type SealBox,
} from "../src/sandbox_file.ts";
import { snapshotIdentity } from "../src/sandbox_snapshot.ts";

const PAGE = 64 * 1024;

const PINS = {
  kernelWasm: { sha256: "ab".repeat(32), rev: "a".repeat(40) },
  image: { sha256: "cd".repeat(32) },
  browserImage: { sha256: "ef".repeat(32) },
} as unknown as Pins;

function image(pages = 2): SandboxSealImage {
  const kernelMemory = new Uint8Array(pages * PAGE);
  for (let i = 0; i < kernelMemory.byteLength; i += 4093) {
    kernelMemory[i] = i % 251;
  }
  return {
    version: 2,
    kernelToken: 0x1234n,
    kernelMemory,
    processes: [],
    hostWaits: [],
    monotonicNs: 5n,
    realtimeOffsetNs: 0n,
  };
}

/** A zip with `manifest` as written and `memory` stored, not deflated:
 * a flipped byte there is caught by the CRC-32 alone. */
function storedZip(
  manifest: Record<string, unknown>,
  memory: Uint8Array,
): Promise<Blob> {
  return writeZip([
    {
      name: "snapshot.json",
      bytes: new TextEncoder().encode(JSON.stringify(manifest)),
      deflate: false,
    },
    { name: "kernel-memory", bytes: memory, deflate: false },
  ]);
}

function manifestFor(memoryBytes: number, built = savedBuiltFrom(PINS)) {
  return {
    version: 2,
    kernelToken: { $bigint: "4660" },
    hostWaits: [],
    monotonicNs: { $bigint: "5" },
    realtimeOffsetNs: { $bigint: "0" },
    format: FORMAT,
    builtFrom: built,
    memoryBytes,
  };
}

/** Deps that record what happened. `outcome` is what a restore gives
 * (or throws); `freshUp` whether a fresh sandbox comes up. */
function harness(
  {
    seal,
    outcome = { up: true, jupyter: "ready" },
    freshUp = true,
    small = false,
    canReplace = true,
  }: {
    seal?: SandboxFileDeps["seal"];
    outcome?: ReplaceOutcome | Error;
    freshUp?: boolean | Error;
    small?: boolean;
    canReplace?: boolean;
  } = {},
) {
  const posted: SandboxFileMessage[] = [];
  const replaced: SandboxSealImage[] = [];
  const fresh: string[] = [];
  const deps: SandboxFileDeps = {
    canReplace,
    seal,
    pins: () => Promise.resolve(PINS),
    smallDevice: small,
    replace: (box) => {
      // The restore takes the seal out of the box.
      replaced.push(box.image!);
      box.image = undefined;
      return outcome instanceof Error
        ? Promise.reject(outcome)
        : Promise.resolve(outcome);
    },
    startFresh: (why) => {
      fresh.push(why);
      return freshUp instanceof Error
        ? Promise.reject(freshUp)
        : Promise.resolve(freshUp);
    },
    post: (message) => posted.push(message),
  };
  const done = () => {
    const dones = posted.filter((m) => m.type === "sandbox-done");
    assertEquals(dones.length, 1, "exactly one sandbox-done");
    const last = posted.at(-1);
    assert(last?.type === "sandbox-done", JSON.stringify(last?.type));
    return last;
  };
  return { deps, posted, replaced, fresh, done };
}

/** A file Save made of `sealed`. */
async function savedFile(sealed = image()): Promise<Blob> {
  const h = harness({ seal: () => Promise.resolve(sealed) });
  await saveSandbox(h.deps);
  const saved = h.posted.find((m) => m.type === "sandbox-saved");
  assert(saved?.type === "sandbox-saved");
  return saved.blob;
}

Deno.test("Save seals, hands over a file Load takes, and restores the same seal in place", async () => {
  const sealed = image();
  const h = harness({ seal: () => Promise.resolve(sealed) });
  await saveSandbox(h.deps);
  assertEquals(h.posted.map((m) => m.type), [
    "sandbox-saved",
    "sandbox-replacing",
    "sandbox-done",
  ]);
  assertEquals(h.replaced, [sealed]);
  assertEquals(h.fresh, []);
  const done = h.done();
  assertEquals(
    [done.outcome, done.saved, done.jupyter, done.why],
    ["restored", true, "ready", undefined],
  );
  assert(sandboxFileOk(done));
  const saved = h.posted[0];
  assert(saved.type === "sandbox-saved");
  assert(/^yurt-sandbox-\d{4}-\d\d-\d\d-\d{4}\.zip$/.test(saved.name));
  assertEquals(
    await decodeLoadedSnapshot(
      saved.blob.stream(),
      snapshotIdentity(PINS),
      false,
    ),
    sealed,
  );
});

Deno.test("a Save whose seal fails starts a fresh sandbox and says the files are gone", async () => {
  const h = harness({ seal: () => Promise.reject(new Error("stuck")) });
  await saveSandbox(h.deps);
  assertEquals(h.replaced, []);
  assertEquals(h.fresh.length, 1);
  const done = h.done();
  assertEquals([done.outcome, done.saved], ["fresh", false]);
  assert(/saving failed: stuck.*files are gone/.test(done.why ?? ""));
  assert(!sandboxFileOk(done));
});

Deno.test("a page that cannot replace its sandbox, or has none that seals, refuses with nothing changed", async () => {
  for (
    const [h, run] of [
      [harness(), saveSandbox],
      [
        harness({ seal: () => Promise.resolve(image()), canReplace: false }),
        saveSandbox,
      ],
      [
        harness({ canReplace: false }),
        (d: SandboxFileDeps) => loadSandbox(d, new Blob()),
      ],
    ] as const
  ) {
    await run(h.deps);
    assertEquals(h.replaced, []);
    assertEquals(h.fresh, []);
    assertEquals(h.done().outcome, "refused");
  }
});

Deno.test("Load needs no running sandbox, only a page that can replace one", async () => {
  const sealed = image(3);
  const file = await savedFile(sealed);
  // No seal: the boot failed, and a Load is the way back.
  const h = harness();
  await loadSandbox(h.deps, file);
  assertEquals(h.replaced, [sealed]);
  assertEquals(h.posted.map((m) => m.type), [
    "sandbox-replacing",
    "sandbox-done",
  ]);
  assertEquals([h.done().outcome, h.done().jupyter], ["restored", "ready"]);
  assert(sandboxFileOk(h.done()));
});

Deno.test("a loaded seal whose shell comes up without Jupyter stays, but is not reported ok", async () => {
  const file = await savedFile();
  for (
    const [outcome, expect] of [
      [{ up: true, jupyter: "missing" }, /has no Python set/],
      [
        { up: true, jupyter: "failed", error: "Jupyter did not start: x" },
        /Jupyter did not start: x/,
      ],
    ] as const
  ) {
    const h = harness({ outcome });
    await loadSandbox(h.deps, file);
    assertEquals(h.fresh, [], "a working shell is not replaced again");
    const done = h.done();
    assertEquals(done.outcome, "restored");
    assert(!sandboxFileOk(done));
    assert(expect.test(done.why ?? ""), done.why);
  }
  // A page with no Jupyter at all (a phone's): ok.
  const h = harness({ outcome: { up: true, jupyter: "none" } });
  await loadSandbox(h.deps, file);
  assert(sandboxFileOk(h.done()));
});

Deno.test("a loaded seal that does not start, or whose restore throws, gives way to a fresh sandbox; one more failure is said too", async () => {
  const file = await savedFile();
  for (
    const [outcome, freshUp, expect] of [
      [{ up: false, error: "restore: bad memory" }, true, "fresh"],
      [new Error("restore threw"), true, "fresh"],
      [{ up: false }, false, "none"],
      [{ up: false }, new Error("fresh threw"), "none"],
    ] as const
  ) {
    const h = harness({ outcome, freshUp });
    await loadSandbox(h.deps, file);
    assertEquals(h.fresh.length, 1);
    const done = h.done();
    assertEquals(done.outcome, expect);
    assert(/the loaded sandbox did not start/.test(done.why ?? ""), done.why);
  }
});

Deno.test("a throw outside the outcomes still ends in exactly one sandbox-done", async () => {
  const h = harness({ seal: () => Promise.resolve(image()) });
  h.deps.pins = () => Promise.reject(new Error("pins gone"));
  await loadSandbox(h.deps, await savedFile());
  assertEquals(h.done().outcome, "refused");
  const posted: SandboxFileMessage[] = [];
  let throwOnce = true;
  await saveSandbox({
    ...h.deps,
    pins: () => Promise.resolve(PINS),
    post: (message) => {
      if (message.type === "sandbox-saved" && throwOnce) {
        throwOnce = false;
        throw new Error("post threw");
      }
      posted.push(message);
    },
  });
  const dones = posted.filter((m) => m.type === "sandbox-done");
  assertEquals(dones.length, 1);
  assert(dones[0].type === "sandbox-done");
  assertEquals(dones[0].saved, false); // Past every inner catch: the outcome is unknown, and said so.
  const later: SandboxFileMessage[] = [];
  await loadSandbox({
    ...h.deps,
    pins: () => Promise.resolve(PINS),
    post: (message) => {
      if (message.type === "sandbox-replacing") throw new Error("post threw");
      later.push(message);
    },
  }, await savedFile());
  assertEquals(later.length, 1);
  assert(later[0].type === "sandbox-done");
  assertEquals(later[0].outcome, "none");
  assert(/post threw; reload the page/.test(later[0].why ?? ""));
});

Deno.test("Save hands the restore its seal and keeps none", async () => {
  let box: SealBox | undefined;
  const h = harness({ seal: () => Promise.resolve(image()) });
  h.deps.replace = (given) => {
    box = given;
    return Promise.resolve({ up: true, jupyter: "ready" });
  };
  await saveSandbox(h.deps);
  assert(box !== undefined);
  assertEquals(box.image, undefined, "emptied even when the restore did not");
});

/** Each refused file: no replace, no fresh sandbox, nothing changed, and
 * the reason says `expect`. */
async function refusedUntouched(
  file: Blob,
  expect: RegExp,
  small = false,
): Promise<void> {
  const h = harness({ small });
  await loadSandbox(h.deps, file);
  assertEquals(h.replaced, [], `${expect}: replaced`);
  assertEquals(h.fresh, [], `${expect}: fresh`);
  assertEquals(h.posted.map((m) => m.type), ["sandbox-done"]);
  const done = h.done();
  assertEquals(done.outcome, "refused");
  assert(expect.test(done.why ?? ""), `${done.why} !~ ${expect}`);
}

Deno.test("a seal that holds host waits or scratch outside its memory is refused", async () => {
  const memory = image().kernelMemory;
  await refusedUntouched(
    await storedZip({
      ...manifestFor(memory.byteLength),
      hostWaits: [{
        parkKey: { $bigint: "1" },
        ticket: { $bigint: "1" },
        sourceKind: 1,
        param: { $bigint: "0" },
        pid: 1,
        tid: 1,
      }],
    }, memory),
    /holds 0 processes and 1 host waits/,
  );
  await refusedUntouched(
    await storedZip({
      ...manifestFor(memory.byteLength),
      executor: {
        contexts: [],
        freeScratch: [{ start: memory.byteLength - 8, length: 64 }],
      },
    }, memory),
    /executor scratch .* lies outside its/,
  );
});

Deno.test("a file saved by another build is refused before anything changes, with what differs", async () => {
  const memory = image().kernelMemory;
  for (
    const other of [
      { kernelSha256: "00".repeat(32) },
      { kernelRev: "0".repeat(40) },
      { sealVersion: 1 },
      { bootSetup: 1 },
      { imageSha256: "00".repeat(32) },
    ]
  ) {
    const key = Object.keys(other)[0];
    await refusedUntouched(
      await storedZip(
        manifestFor(memory.byteLength, { ...savedBuiltFrom(PINS), ...other }),
        memory,
      ),
      new RegExp(
        `saved by another Yurt build \\(${key} .*loads only on the build that saved it`,
      ),
    );
  }
});

Deno.test("a damaged, truncated or foreign file is refused before anything changes", async () => {
  const memory = image().kernelMemory;
  const good = new Uint8Array(
    await (await storedZip(manifestFor(memory.byteLength), memory))
      .arrayBuffer(),
  );
  // A flipped byte in the stored memory: only its CRC-32 says so.
  const flipped = good.slice();
  flipped[good.byteLength - 2 * PAGE] ^= 0xff;
  await refusedUntouched(new Blob([flipped]), /fails its CRC-32/);
  await refusedUntouched(
    new Blob([good.subarray(0, good.byteLength / 2)]),
    /truncated/,
  );
  await refusedUntouched(
    new Blob(["just some text, longer than a zip entry header"]),
    /not a zip/,
  );
  await refusedUntouched(
    await storedZip({ ...manifestFor(memory.byteLength), format: 3 }, memory),
    /is format 3/,
  );
});

Deno.test("kernel memory too large for the device, or not whole pages, is refused before it is allocated", async () => {
  // Over 4 GiB of memory with none behind it: allocating first would
  // throw a RangeError, not the refusal.
  await refusedUntouched(
    await storedZip(manifestFor(2 ** 33), new Uint8Array()),
    /kernel memory is 8192 MiB, over the 1024 MiB this page loads/,
  );
  await refusedUntouched(
    await storedZip(
      manifestFor(LOAD_MEMORY_MAX_SMALL_BYTES + PAGE),
      new Uint8Array(),
    ),
    /over the 512 MiB a phone or tablet loads/,
    true,
  );
  await refusedUntouched(
    await storedZip(manifestFor(PAGE + 1), new Uint8Array(PAGE + 1)),
    /not whole 64 KiB pages/,
  );
});

Deno.test("the memory bounds", () => {
  assertEquals(memoryRefusal(LOAD_MEMORY_MAX_BYTES, false), undefined);
  assert(memoryRefusal(LOAD_MEMORY_MAX_BYTES + PAGE, false));
  assertEquals(memoryRefusal(LOAD_MEMORY_MAX_SMALL_BYTES, true), undefined);
  assert(memoryRefusal(LOAD_MEMORY_MAX_SMALL_BYTES + PAGE, true));
  assert(memoryRefusal(0, false));
  assert(memoryRefusal(-PAGE, false));
});

Deno.test("decodeLoadedSnapshot refuses with LoadRefused only", async () => {
  await assertRejects(
    () =>
      decodeLoadedSnapshot(
        new Blob(["x"]).stream(),
        snapshotIdentity(PINS),
        false,
      ),
    LoadRefused,
  );
});

Deno.test("the saved file's name says when it was saved", () => {
  assertEquals(
    savedFileName(new Date(2026, 10, 17, 9, 5)),
    "yurt-sandbox-2026-11-17-0905.zip",
  );
});
