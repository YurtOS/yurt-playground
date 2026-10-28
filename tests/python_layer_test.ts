import { assertEquals, assertThrows } from "@std/assert";
import {
  captureLayer,
  decodeTar,
  encodeTar,
  type GuestFs,
  inLayer,
  installWithLayer,
  LayerFailed,
  type LayerInstallDeps,
  layerKey,
} from "../src/python_layer.ts";
import type { LayerEntry } from "../src/stage.ts";

const enc = new TextEncoder();
const meta = { mode: 0o755, uid: 0, gid: 0, mtime: 1_761_600_000 };

Deno.test("a layer round-trips through tar, long paths and link targets included", () => {
  const long = `/usr/local/lib/python3.14/site-packages/${"a".repeat(90)}/${
    "b".repeat(120)
  }.py`;
  const entries: LayerEntry[] = [
    { type: "dir", path: "/usr/local/lib", ...meta },
    {
      type: "file",
      path: "/etc/pip.conf",
      ...meta,
      mode: 0o644,
      bytes: enc.encode("[global]\n"),
    },
    {
      type: "file",
      path: long,
      ...meta,
      mode: 0o600,
      uid: 1000,
      gid: 1000,
      bytes: new Uint8Array(1025).fill(7),
    },
    {
      type: "file",
      path: "/usr/local/empty",
      ...meta,
      bytes: new Uint8Array(),
    },
    {
      type: "symlink",
      path: "/usr/local/bin/python",
      ...meta,
      mode: 0o777,
      target: "python3",
    },
    {
      type: "symlink",
      path: "/usr/local/bin/far",
      ...meta,
      mode: 0o777,
      target: `/opt/${"t".repeat(150)}`,
    },
  ];
  assertEquals(decodeTar(encodeTar(entries)), entries);
});

Deno.test("a tar entry that would escape the root is refused", () => {
  const tar = encodeTar([{ type: "dir", path: "/x", ...meta }]);
  // Rewrite the name to "../x/" and fix the checksum.
  tar.set(enc.encode("../x/\0"), 0);
  tar.fill(0x20, 148, 156);
  let sum = 0;
  for (const byte of tar.subarray(0, 512)) sum += byte;
  tar.set(enc.encode(sum.toString(8).padStart(6, "0") + "\0 "), 148);
  assertThrows(() => decodeTar(tar), Error, "bad path");
});

Deno.test("a layer holds what the install changed, not the user's files or scratch", () => {
  for (
    const path of [
      "/usr/local/bin/python3",
      "/etc/pip.conf",
      "/var/lib/yurt-pkg/installed.sqlite",
      "/var/cache/yurt-pkg/browser-repos/official/current/index.json",
    ]
  ) {
    assertEquals(inLayer(path), true, path);
  }
  for (
    const path of [
      "/tmp/x",
      "/tmp",
      "/home/user/.ash_history",
      "/root/.profile",
      "/var/cache/yurt-pkg/browser/staging/repo/index.json",
      "/proc/1/stat",
      "/",
    ]
  ) {
    assertEquals(inLayer(path), false, path);
  }
});

/** A guest filesystem in memory. */
function memoryFs(files: Record<string, LayerEntry>): GuestFs {
  return {
    stat: (path) => {
      const e = files[path];
      if (e === undefined) return undefined;
      return {
        type: e.type,
        mode: e.mode,
        uid: e.uid,
        gid: e.gid,
        mtime: e.mtime,
        size: e.type === "file" ? e.bytes.byteLength : 0,
      };
    },
    readFile: (path) => (files[path] as { bytes: Uint8Array }).bytes,
    readlink: (path) => (files[path] as { target: string }).target,
    readdir: (path) =>
      Object.keys(files).filter((p) =>
        p.startsWith(`${path}/`) && !p.slice(path.length + 1).includes("/")
      ).map((p) => p.slice(path.length + 1)),
  };
}

Deno.test("a touched directory brings everything beneath it; gone and excluded paths do not", () => {
  const files: Record<string, LayerEntry> = {
    "/usr/local/lib/py": { type: "dir", path: "/usr/local/lib/py", ...meta },
    "/usr/local/lib/py/a.py": {
      type: "file",
      path: "/usr/local/lib/py/a.py",
      ...meta,
      bytes: enc.encode("a"),
    },
    "/usr/local/lib/py/sub": {
      type: "dir",
      path: "/usr/local/lib/py/sub",
      ...meta,
    },
    "/usr/local/lib/py/sub/b.py": {
      type: "file",
      path: "/usr/local/lib/py/sub/b.py",
      ...meta,
      bytes: enc.encode("b"),
    },
    "/usr/local/bin/python": {
      type: "symlink",
      path: "/usr/local/bin/python",
      ...meta,
      target: "python3",
    },
    "/tmp/tmp.x": {
      type: "file",
      path: "/tmp/tmp.x",
      ...meta,
      bytes: enc.encode("t"),
    },
  };
  const layer = captureLayer(memoryFs(files), [
    // A directory renamed into place is one touched path.
    "/usr/local/lib/py",
    "/usr/local/bin/python",
    "/usr/local/lib/py/a.py", // twice: once
    "/tmp/tmp.x",
    "/var/cache/yurt-pkg/browser/staging", // removed since
  ]);
  assertEquals(layer.map((e) => e.path), [
    "/usr/local/bin/python",
    "/usr/local/lib/py",
    "/usr/local/lib/py/a.py",
    "/usr/local/lib/py/sub",
    "/usr/local/lib/py/sub/b.py",
  ]);
});

Deno.test("a layer's key is the slim image and the exact releases, in any order", () => {
  const releases = [
    {
      name: "numpy",
      version: "2.5.0",
      build: "yurt_0",
      sha256: "A".repeat(64),
    },
    {
      name: "python",
      version: "3.14.7",
      build: "yurt_0",
      sha256: "b".repeat(64),
    },
  ];
  assertEquals(
    layerKey("ABC", releases),
    `abc/numpy@2.5.0-yurt_0:${"a".repeat(16)}+python@3.14.7-yurt_0:${
      "b".repeat(16)
    }`,
  );
  // Republished under the same version and build: another key.
  assertEquals(
    layerKey("abc", [releases[0], {
      ...releases[1],
      sha256: "c".repeat(64),
    }]) ===
      layerKey("abc", releases),
    false,
  );
  assertEquals(
    layerKey("abc", [...releases].reverse()),
    layerKey("ABC", releases),
  );
  assertEquals(
    layerKey("abc", [releases[0], { ...releases[1], build: "yurt_1" }]) ===
      layerKey("abc", releases),
    false,
  );
});

/** A coordinator in memory: what was applied, installed, kept, said. */
function fakeDeps(
  options: {
    stored?: { key: string; entries: string[] };
    live?: string | Error | null;
    probe?: boolean | null;
    applyThrows?: boolean;
    pristine?: boolean;
    drainThrows?: boolean;
  },
) {
  const log: string[] = [];
  let stored = options.stored;
  const deps: LayerInstallDeps<string> = {
    image: "img",
    pristine: options.pristine ?? true,
    layer: {
      drainChanged: () => {
        log.push("drain");
        if (options.drainThrows) throw new Error("drain failed");
        return ["/usr/local/bin/python3"];
      },
      capture: (touched) => {
        log.push(`capture ${touched}`);
        return ["captured"];
      },
      apply: (entries) => {
        log.push(`apply ${entries}`);
        if (options.applyThrows) throw new Error("apply failed");
      },
    },
    store: {
      storedKey: (image) =>
        Promise.resolve(
          stored?.key.startsWith(`${image}/`) ? stored.key : undefined,
        ),
      get: (key) =>
        Promise.resolve(stored?.key === key ? stored.entries : undefined),
      put: (key, entries) => {
        log.push(`put ${key} ${entries}`);
        stored = { key, entries };
        return Promise.resolve();
      },
      drop: () => {
        log.push("drop");
        stored = undefined;
        return Promise.resolve();
      },
    },
    liveKey: () =>
      options.live instanceof Error
        ? Promise.reject(options.live)
        : Promise.resolve(
          options.live === null ? undefined : (options.live ?? "img/set1"),
        ),
    install: async (between) => {
      log.push("before");
      between.before();
      log.push("pkg install");
      await Promise.resolve();
      between.after();
      log.push("after");
    },
    probe: () =>
      Promise.resolve(
        options.probe === null ? undefined : (options.probe ?? true),
      ),
    progress: (text) => log.push(`say ${text}`),
  };
  return { deps, log };
}

Deno.test("a first visit installs with pkg and keeps what it wrote, keyed by the live set", async () => {
  const { deps, log } = fakeDeps({});
  assertEquals(await installWithLayer(deps), "pkg");
  assertEquals(log, [
    "before",
    "drain",
    "pkg install",
    "drain",
    "capture /usr/local/bin/python3",
    "after",
    "say Python: keeping the install for the next visit",
    "put img/set1 captured",
  ]);
});

Deno.test("a later visit with the same live set writes the stored layer and runs no pkg", async () => {
  const { deps, log } = fakeDeps({
    stored: { key: "img/set1", entries: ["e1"] },
  });
  assertEquals(await installWithLayer(deps), "layer");
  assertEquals(log, [
    "say Python: installing from this browser's earlier install",
    "apply e1",
  ]);
});

Deno.test("a newer live set installs with pkg and replaces the stored layer", async () => {
  const { deps, log } = fakeDeps({
    stored: { key: "img/set1", entries: ["e1"] },
    live: "img/set2",
  });
  assertEquals(await installWithLayer(deps), "pkg");
  assertEquals(log.includes("apply e1"), false);
  assertEquals(log.at(-1), "put img/set2 captured");
});

Deno.test("offline, the layer stored for this image is used", async () => {
  const { deps, log } = fakeDeps({
    stored: { key: "img/set1", entries: ["e1"] },
    live: new Error("offline"),
  });
  assertEquals(await installWithLayer(deps), "layer");
  assertEquals(log.includes("apply e1"), true);
});

Deno.test("offline with no layer for this image: pkg, and nothing kept under a guessed key", async () => {
  const { deps, log } = fakeDeps({
    stored: { key: "other-image/set1", entries: ["e1"] },
    live: new Error("offline"),
  });
  assertEquals(await installWithLayer(deps), "pkg");
  assertEquals(
    log.some((line) => line.startsWith("put") || line.startsWith("capture")),
    false,
  );
  assertEquals(log.includes("apply e1"), false);
});

/** `installWithLayer` failing as a LayerFailed, and the log by then. */
async function layerFails(deps: LayerInstallDeps<string>): Promise<string> {
  try {
    await installWithLayer(deps);
  } catch (error) {
    if (error instanceof LayerFailed) return error.message;
    throw error;
  }
  throw new Error("no LayerFailed");
}

Deno.test("a layer that leaves no python3 is dropped and fails: no pkg in that sandbox", async () => {
  // pkg would refuse the layer's files as unmanaged, or call the set
  // installed from the layer's records: the retry is a fresh sandbox.
  const { deps, log } = fakeDeps({
    stored: { key: "img/set1", entries: ["e1"] },
    probe: false,
  });
  const message = await layerFails(deps);
  assertEquals(message.includes("no python3 after it"), true, message);
  assertEquals(log.includes("drop"), true);
  assertEquals(log.includes("pkg install"), false);
  assertEquals(log.some((line) => line.startsWith("put")), false);
});

Deno.test("a layer that fails to apply is dropped and fails: no pkg in that sandbox", async () => {
  const { deps, log } = fakeDeps({
    stored: { key: "img/set1", entries: ["e1"] },
    applyThrows: true,
  });
  const message = await layerFails(deps);
  assertEquals(message.includes("apply failed"), true, message);
  assertEquals(log.includes("drop"), true);
  assertEquals(log.includes("pkg install"), false);
});

Deno.test("a probe that cannot tell keeps the layer: the kernel's start tells", async () => {
  const { deps, log } = fakeDeps({
    stored: { key: "img/set1", entries: ["e1"] },
    probe: null,
  });
  assertEquals(await installWithLayer(deps), "layer");
  assertEquals(log.includes("drop"), false);
});

Deno.test("a sandbox that installed anything before neither uses a layer nor keeps one", async () => {
  // A retry after a failed transaction, or a Packages install first: the
  // layer's records would replace pkg's, and what pkg writes now is not
  // the whole set.
  const { deps, log } = fakeDeps({
    pristine: false,
    stored: { key: "img/set1", entries: ["e1"] },
  });
  assertEquals(await installWithLayer(deps), "pkg");
  assertEquals(log.includes("apply e1"), false);
  assertEquals(log.includes("pkg install"), true);
  assertEquals(
    log.some((line) => line.startsWith("capture") || line.startsWith("put")),
    false,
  );
});

Deno.test("a repository that answers with no usable set (yanked) uses no stored layer", async () => {
  const { deps, log } = fakeDeps({
    stored: { key: "img/set1", entries: ["e1"] },
    live: null,
  });
  assertEquals(await installWithLayer(deps), "pkg");
  assertEquals(log.includes("apply e1"), false);
  assertEquals(
    log.some((line) => line.startsWith("capture") || line.startsWith("put")),
    false,
  );
});

Deno.test("an install that wrote nothing keeps no empty layer", async () => {
  const { deps, log } = fakeDeps({});
  deps.layer!.capture = () => [];
  assertEquals(await installWithLayer(deps), "pkg");
  assertEquals(log.some((line) => line.startsWith("put")), false);
});

Deno.test("a drain that fails keeps nothing and fails nothing", async () => {
  const { deps, log } = fakeDeps({ drainThrows: true });
  assertEquals(await installWithLayer(deps), "pkg");
  assertEquals(log.includes("pkg install"), true);
  assertEquals(
    log.some((line) => line.startsWith("capture") || line.startsWith("put")),
    false,
  );
});

Deno.test("a pkg install that fails keeps nothing and fails as before", async () => {
  const { deps, log } = fakeDeps({});
  deps.install = () =>
    Promise.reject(new Error("pkg install Python failed: x"));
  let error: unknown;
  try {
    await installWithLayer(deps);
  } catch (e) {
    error = e;
  }
  assertEquals((error as Error).message, "pkg install Python failed: x");
  assertEquals(log.some((line) => line.startsWith("put")), false);
});

Deno.test("with no layer support (no store, no image), pkg installs as before", async () => {
  const { deps, log } = fakeDeps({});
  deps.store = undefined;
  assertEquals(await installWithLayer(deps), "pkg");
  assertEquals(
    log.some((line) => line.startsWith("capture") || line.startsWith("put")),
    false,
  );
});
