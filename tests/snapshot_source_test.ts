import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import type { SandboxSealImage } from "@yurt/kernel-host-interface-js";
import { restoreSnapshot, snapshotOrBoot } from "../src/boot.ts";
import { contentSecurityPolicy, documentPolicy } from "../src/csp.ts";
import { imagePartRange, imagePartsManifest } from "../src/image_parts.ts";
import { sha256Hex } from "../src/integrity.ts";
import { parsePins } from "../src/pins.ts";
import {
  type BuiltFrom,
  encodeSandboxSnapshot,
  FORMAT,
  snapshotIdentity,
  SnapshotMismatch,
  type SnapshotPin,
} from "../src/sandbox_snapshot.ts";
import {
  capturePackages,
  confinedFetch,
  isUploadedSnapshotId,
  SNAPSHOT_FILE,
  SNAPSHOT_MANIFEST,
  SNAPSHOT_REFS_API,
  SNAPSHOT_SOURCE,
  snapshotRef,
  uploadedSnapshot,
  uploadedSnapshotBase,
  uploadedSnapshotPath,
} from "../src/snapshot_source.ts";

const ID = "0123456789abcdef0123456789abcdef01234567";
const BASE = `https://raw.githubusercontent.com/YurtOS/yurt-playground/${ID}/`;

/** The GitHub API's answer for the repository's snapshot refs. */
function refsAnswer(shas: string[] = [ID]): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(
    shas.map((sha, at) => ({
      ref: `refs/snapshots/s${at}`,
      object: { sha, type: "commit" },
    })),
  ));
}

const raw = JSON.parse(
  await Deno.readTextFile(new URL("../artifacts/pins.json", import.meta.url)),
);
// The site's pins without a pinned snapshot: an uploaded one needs none.
const pinsText = JSON.stringify({ ...raw, snapshot: undefined });
const pins = parsePins(JSON.parse(pinsText));
const PYTHON_SET = "cd/python@3.14.7-yurt_0:0123456789abcdef";
const BUILT: BuiltFrom = { ...snapshotIdentity(pins), pythonSet: PYTHON_SET };

function image(memoryBytes: number): SandboxSealImage {
  // Random, so the gzipped file is as large as the memory: parts.
  const kernelMemory = new Uint8Array(memoryBytes);
  for (let at = 0; at < memoryBytes; at += 65536) {
    crypto.getRandomValues(kernelMemory.subarray(at, at + 65536));
  }
  return {
    version: 1,
    kernelToken: 1n,
    kernelMemory,
    processes: [],
    hostWaits: [],
    monotonicNs: 1n,
    realtimeOffsetNs: 0n,
    executor: { contexts: [], freeScratch: [] },
  };
}

/** The files one uploaded snapshot's commit holds, by URL, as
 * scripts/snapshot-local.ts writes them; and its manifest. */
async function upload(
  builtFrom: BuiltFrom = BUILT,
  memoryBytes = 45 * 1024 * 1024,
): Promise<{ files: Map<string, Uint8Array>; manifest: SnapshotPin }> {
  const file = new Uint8Array(
    await (await encodeSandboxSnapshot(image(memoryBytes), builtFrom))
      .arrayBuffer(),
  );
  const parts = imagePartsManifest(SNAPSHOT_FILE, file.byteLength);
  const files = new Map<string, Uint8Array>();
  const sums: string[] = [];
  for (const [index, name] of parts.parts.entries()) {
    const [start, end] = imagePartRange(index, file.byteLength)!;
    const bytes = file.slice(start, end);
    files.set(`${BASE}${name}`, bytes);
    sums.push(await sha256Hex(bytes));
  }
  files.set(
    `${BASE}${SNAPSHOT_FILE}.parts.json`,
    new TextEncoder().encode(JSON.stringify(parts)),
  );
  const manifest: SnapshotPin = {
    releaseRepo: "YurtOS/yurt-playground",
    release: "refs/snapshots/test",
    format: FORMAT,
    sha256: await sha256Hex(file),
    size: file.byteLength,
    parts: sums,
    builtFrom,
  };
  files.set(SNAPSHOT_REFS_API, refsAnswer());
  files.set(
    `${BASE}${SNAPSHOT_MANIFEST}`,
    new TextEncoder().encode(
      JSON.stringify({ ...manifest, name: "test", packages: [] }),
    ),
  );
  return { files, manifest };
}

/** Swap in a global fetch that answers `./pins.json` and `files`, and
 * records every URL asked for. */
async function withFetch<T>(
  files: Map<string, Uint8Array>,
  run: (fetched: string[]) => Promise<T>,
): Promise<T> {
  const fetched: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    fetched.push(url);
    if (url.endsWith("pins.json") && !url.startsWith("https:")) {
      return Promise.resolve(new Response(pinsText));
    }
    const body = files.get(url);
    return Promise.resolve(
      body === undefined
        ? new Response(null, { status: 404 })
        : new Response(body as Uint8Array<ArrayBuffer>),
    );
  }) as typeof fetch;
  try {
    return await run(fetched);
  } finally {
    globalThis.fetch = realFetch;
  }
}

const env = (live: string | null | undefined = PYTHON_SET) => ({
  isolated: true,
  fetchBytes: () => Promise.reject(new Error("not in this test")),
  show: () => {},
  term: {} as never,
  snapshotId: ID,
  livePythonSet: () => Promise.resolve(live),
});

Deno.test("only a commit sha names an uploaded snapshot", () => {
  assert(isUploadedSnapshotId(ID));
  for (
    const value of [
      null,
      undefined,
      "",
      "1",
      "capture",
      ID.toUpperCase(),
      ID.slice(1),
      `${ID}0`,
      `${ID}/`,
      `../${ID.slice(3)}`,
      "https://example.com/x",
      `https://raw.githubusercontent.com/YurtOS/yurt-playground/${ID}/`,
    ]
  ) {
    assertEquals(isUploadedSnapshotId(value), false, String(value));
  }
});

Deno.test("an uploaded snapshot is read from the one repository path, at its commit", () => {
  assertEquals(
    SNAPSHOT_SOURCE,
    "https://raw.githubusercontent.com/YurtOS/yurt-playground/",
  );
  assertEquals(uploadedSnapshotBase(ID), BASE);
  assertEquals(uploadedSnapshotPath(ID), `${BASE}sandbox.seal.gz`);
  for (const bad of ["1", "https://example.com/", "../x"]) {
    assertThrows(() => uploadedSnapshotBase(bad), Error, "not an uploaded");
  }
});

Deno.test("a confined fetch reads only under its base", async () => {
  const asked: string[] = [];
  const fetch = confinedFetch(BASE, (input) => {
    asked.push(String(input));
    return Promise.resolve(new Response("ok"));
  });
  assertEquals(await (await fetch(`${BASE}sandbox.seal.gz.0`)).text(), "ok");
  for (
    const url of [
      new URL("../other/manifest.json", BASE).href,
      new URL("%2e%2e/x", BASE).href,
      `${SNAPSHOT_SOURCE}main/README.md`,
      "https://example.com/sandbox.seal.gz.0",
      `${BASE}sandbox.seal.gz.0?x=1`,
    ]
  ) {
    await assertRejects(() => fetch(url), Error, "refusing");
  }
  assertEquals(asked, [`${BASE}sandbox.seal.gz.0`]);
});

Deno.test("an uploaded snapshot's manifest takes every check a pin does", async () => {
  const { files, manifest } = await upload(BUILT, 1024);
  const fetchFrom =
    (bytes: Map<string, Uint8Array>) => (input: RequestInfo | URL) => {
      const body = bytes.get(String(input));
      return Promise.resolve(
        body === undefined
          ? new Response(null, { status: 404 })
          : new Response(body as Uint8Array<ArrayBuffer>),
      );
    };
  const got = await uploadedSnapshot(ID, pins, fetchFrom(files));
  assertEquals(got.pin, manifest);
  assertEquals(got.path, `${BASE}sandbox.seal.gz`);
  const withManifest = (value: unknown) =>
    new Map([
      ...files,
      [`${BASE}manifest.json`, new TextEncoder().encode(JSON.stringify(value))],
    ]);
  const refusals: [unknown, string][] = [
    [
      { ...manifest, builtFrom: { ...BUILT, kernelRev: "k0" } },
      `uploaded snapshot ${ID} was built from kernelRev k0, not ${pins.kernelWasm.rev}`,
    ],
    [
      { ...manifest, builtFrom: { ...BUILT, bootSetup: 99 } },
      "bootSetup 99",
    ],
    [{ ...manifest, format: 2 }, `uploaded snapshot ${ID} is format 2, not 3`],
    [
      { ...manifest, parts: [] },
      `the uploaded snapshot ${ID} entry is malformed`,
    ],
  ];
  for (const [value, message] of refusals) {
    await assertRejects(
      () => uploadedSnapshot(ID, pins, fetchFrom(withManifest(value))),
      SnapshotMismatch,
      message,
    );
  }
  await assertRejects(
    () =>
      uploadedSnapshot(
        ID,
        pins,
        fetchFrom(new Map([[SNAPSHOT_REFS_API, refsAnswer()]])),
      ),
    Error,
    "fetch manifest.json failed: 404",
  );
  await assertRejects(
    () =>
      uploadedSnapshot(
        ID,
        pins,
        fetchFrom(
          new Map([
            [SNAPSHOT_REFS_API, refsAnswer()],
            [`${BASE}manifest.json`, new TextEncoder().encode("{")],
          ]),
        ),
      ),
    Error,
    "manifest.json is not JSON",
  );
});

Deno.test("?snapshot=<id> checks every part against the uploaded manifest", async () => {
  const { files } = await upload();
  // The second of three parts is not the uploaded bytes.
  const part = `${BASE}sandbox.seal.gz.1`;
  const bad = files.get(part)!.slice();
  bad[7] ^= 1;
  files.set(part, bad);
  await withFetch(files, async (fetched) => {
    await assertRejects(
      () => restoreSnapshot(env(), new Uint8Array(), uploadedSnapshotPath(ID)),
      Error,
      "sandbox snapshot part sandbox.seal.gz.1 sha256 mismatch",
    );
    // Nothing but the site's pins, the refs list and the snapshot's own
    // commit; never
    // the pinned snapshot's path; and no part after the bad one.
    assertEquals(
      fetched.filter((url) => !url.startsWith(BASE)),
      ["./pins.json", SNAPSHOT_REFS_API],
    );
    assertEquals(fetched.includes(`${BASE}sandbox.seal.gz.2`), false);
  });
});

Deno.test("?snapshot=<id> asks the live index before it fetches any part", async () => {
  const { files } = await upload(BUILT, 1024);
  await withFetch(files, async (fetched) => {
    await assertRejects(
      () =>
        restoreSnapshot(
          env("another set"),
          new Uint8Array(),
          uploadedSnapshotPath(ID),
        ),
      SnapshotMismatch,
      "the live index offers another set",
    );
    assertEquals(fetched.filter((url) => url.includes("sandbox.seal")), []);
  });
});

Deno.test("an uploaded snapshot that cannot be had boots the image, as ?snapshot=1 does", async () => {
  const other = await upload({ ...BUILT, imageSha256: "11".repeat(32) }, 1024);
  for (
    const files of [
      // The refs API cannot be had (rate limited, offline).
      new Map<string, Uint8Array>(),
      // No manifest at that commit.
      new Map([[SNAPSHOT_REFS_API, refsAnswer()]]),
      // Another build's.
      other.files,
    ]
  ) {
    await withFetch(files, async () => {
      const warn = console.warn;
      const notes: string[] = [];
      console.warn = (text: string) => notes.push(text);
      try {
        const result = await snapshotOrBoot(
          () =>
            restoreSnapshot(env(), new Uint8Array(), uploadedSnapshotPath(ID)),
          () => Promise.resolve("booted" as never),
        );
        assertEquals(result, { kernel: "booted" as never, restored: false });
      } finally {
        console.warn = warn;
      }
      assertEquals(notes.length, 1);
      assertStringIncludes(notes[0], "booting the image instead");
    });
  }
});

Deno.test("an uploaded snapshot's file is fetched whole and inflated before the restore", async () => {
  // Past every check and the decode, the restore itself is reached: an
  // empty kernel cannot compile, which only a whole, accepted file gets to.
  const { files } = await upload();
  await withFetch(files, async (fetched) => {
    const error = await assertRejects(() =>
      restoreSnapshot(env(), new Uint8Array(), uploadedSnapshotPath(ID))
    );
    assertEquals(error instanceof SnapshotMismatch, false);
    assertEquals(
      String(error).includes("sha256 mismatch") ||
        String(error).includes("truncated"),
      false,
    );
    assertEquals(fetched.includes(`${BASE}sandbox.seal.gz.2`), true);
  });
});

Deno.test("a commit no refs/snapshots ref names is refused before any byte of it is read", async () => {
  // A fork's or a pull request's commit: raw.githubusercontent.com serves
  // it under the repository's path, but the repository never published it.
  const { files } = await upload(BUILT, 1024);
  files.set(SNAPSHOT_REFS_API, refsAnswer(["ab".repeat(20)]));
  await withFetch(files, async (fetched) => {
    await assertRejects(
      () => restoreSnapshot(env(), new Uint8Array(), uploadedSnapshotPath(ID)),
      SnapshotMismatch,
      `uploaded snapshot ${ID} is not a refs/snapshots/* commit of YurtOS/yurt-playground`,
    );
    assertEquals(fetched.filter((url) => url.startsWith(BASE)), []);
  });
});

Deno.test("only a refs/snapshots ref to that very commit publishes it", async () => {
  const answer =
    (body: unknown, status = 200) => (input: RequestInfo | URL) => {
      assertEquals(String(input), SNAPSHOT_REFS_API);
      return Promise.resolve(new Response(JSON.stringify(body), { status }));
    };
  assertEquals(
    await snapshotRef(
      ID,
      answer([
        {
          ref: "refs/snapshots/a",
          object: { sha: "cd".repeat(20), type: "commit" },
        },
        { ref: "refs/snapshots/b", object: { sha: ID, type: "commit" } },
      ]),
    ),
    "refs/snapshots/b",
  );
  for (
    const body of [
      [],
      [{ ref: "refs/heads/main", object: { sha: ID, type: "commit" } }],
      [{ ref: "refs/snapshots/t", object: { sha: ID, type: "tag" } }],
      { message: "Not Found" },
    ]
  ) {
    await assertRejects(
      () => snapshotRef(ID, answer(body)),
      SnapshotMismatch,
      "is not a refs/snapshots/* commit",
    );
  }
  await assertRejects(
    () => snapshotRef(ID, answer({ message: "rate limited" }, 403)),
    Error,
    "cannot list YurtOS/yurt-playground's snapshot refs: 403",
  );
});

Deno.test("the site policy lets the page read uploaded snapshots; JupyterLite's does not", () => {
  assertStringIncludes(contentSecurityPolicy(), ` ${SNAPSHOT_SOURCE}`);
  assertStringIncludes(contentSecurityPolicy(), ` ${SNAPSHOT_REFS_API}`);
  assertStringIncludes(documentPolicy("/index.html", []), SNAPSHOT_SOURCE);
  assertEquals(
    documentPolicy("/jupyter/lab/index.html", []).includes(SNAPSHOT_SOURCE),
    false,
  );
  assertEquals(
    documentPolicy("/jupyter/lab/index.html", []).includes("api.github.com"),
    false,
  );
});

Deno.test("?packages= names packages a capture installs, or fails it", () => {
  assertEquals(capturePackages(null), []);
  assertEquals(capturePackages(""), []);
  assertEquals(capturePackages("pandas,scipy,pandas"), ["pandas", "scipy"]);
  for (const bad of ["Pandas", "a,,b", "../x", "a b", "a;rm", "-x"]) {
    assertThrows(() => capturePackages(bad), Error, "names no package");
  }
});
