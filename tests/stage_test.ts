import { assert, assertEquals } from "@std/assert";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  defaultHostState,
  KernelHostInterface,
  METHOD,
} from "@yurt/kernel-host-interface-js";
import { handlePlaygroundRequest } from "../src/serve.ts";
import { loadPins, resolveArtifacts } from "../src/pins.ts";
import { stageYurtimg } from "../src/stage.ts";

const STAT_MODE = 12;
const STAT_UID = 16;
const STAT_GID = 20;
const STAT_LEN = 48;

const repoRoot = join(fileURLToPath(import.meta.url), "../..");

function openReq(path: string): Uint8Array {
  const bytes = new TextEncoder().encode(path);
  const req = new Uint8Array(12 + bytes.length);
  const view = new DataView(req.buffer);
  view.setUint32(0, 0, true);
  view.setUint32(8, bytes.length, true);
  req.set(bytes, 12);
  return req;
}

function readStat(mk: KernelHostInterface, path: string): DataView {
  const opened = mk.syscall(METHOD.KERNEL_FS_OPEN, openReq(path), 0);
  const fd = Number(opened.rc);
  if (fd < 0) {
    throw new Error(`open ${path} failed: rc=${opened.rc}`);
  }
  const fdBytes = new Uint8Array(4);
  new DataView(fdBytes.buffer).setUint32(0, fd >>> 0, true);
  const out = mk.syscall(METHOD.KERNEL_FS_FSTAT, fdBytes, STAT_LEN);
  if (Number(out.rc) < 0) {
    throw new Error(`fstat ${path} failed: rc=${out.rc}`);
  }
  const stat = out.response ?? new Uint8Array();
  if (stat.byteLength < STAT_LEN) {
    throw new Error(
      `fstat ${path} short response: ${stat.byteLength} < ${STAT_LEN}`,
    );
  }
  mk.syscall(METHOD.KERNEL_FS_CLOSE, fdBytes, 0);
  return new DataView(stat.buffer, stat.byteOffset, stat.byteLength);
}

function statOwner(
  mk: KernelHostInterface,
  path: string,
): { uid: number; gid: number } {
  const view = readStat(mk, path);
  return {
    uid: view.getUint32(STAT_UID, true),
    gid: view.getUint32(STAT_GID, true),
  };
}

function statMode(mk: KernelHostInterface, path: string): number {
  return readStat(mk, path).getUint32(STAT_MODE, true) & 0o7777;
}

/** The one staged kernel both tests read, built at most once: staging the
 * 87 MB image costs seconds, and nothing either test does mutates it. */
let staged: Promise<KernelHostInterface | null> | undefined;

/** A kernel with the pinned image staged into it, or `null` when the
 * artifacts are not resolvable here -- this needs the real image, not a
 * fixture. A skip is a hole in the coverage, so when the caller says the
 * artifacts are required -- `PLAYGROUND_REQUIRE_ARTIFACTS=1`, which CI
 * sets and `layout_test.ts` asserts it sets -- it is a failure instead of
 * a shrug. */
function stagedKernel(): Promise<KernelHostInterface | null> {
  staged ??= buildStagedKernel();
  return staged;
}

async function buildStagedKernel(): Promise<KernelHostInterface | null> {
  const artifactsDir = join(repoRoot, "artifacts");
  try {
    await resolveArtifacts({
      artifactsDir,
      pins: await loadPins(join(artifactsDir, "pins.json")),
      kernelRoot: Deno.env.get("YURT_KERNEL_ROOT") ??
        join(repoRoot, "../yurtos-kernel"),
      portsRoot: Deno.env.get("YURT_PORTS_ROOT"),
    });
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    if (Deno.env.get("PLAYGROUND_REQUIRE_ARTIFACTS") === "1") {
      throw new Error(
        `artifacts were required, so this must not skip: ${why}`,
      );
    }
    console.log(`skipping staged-kernel test: ${why}`);
    return null;
  }
  const kernelRes = await handlePlaygroundRequest(
    new Request("http://playground/yurt_kernel.wasm"),
  );
  const imageRes = await handlePlaygroundRequest(
    new Request("http://playground/playground.yurtimg"),
  );
  if (!kernelRes.ok || !imageRes.ok) {
    throw new Error("failed to load pinned kernel or image");
  }
  const mk = await KernelHostInterface.load(
    new Uint8Array(await kernelRes.arrayBuffer()),
    defaultHostState(),
  );
  await stageYurtimg(
    mk,
    new Uint8Array(await imageRes.arrayBuffer()),
    new Map(),
  );
  return mk;
}

Deno.test({
  name:
    "stageYurtimg applies tar owners so /home is root and /home/user is 1000",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const mk = await stagedKernel();
    if (!mk) return;
    assertEquals(statOwner(mk, "/bin"), { uid: 0, gid: 0 });
    assertEquals(statOwner(mk, "/home"), { uid: 0, gid: 0 });
    assertEquals(statOwner(mk, "/home/user"), { uid: 1000, gid: 1000 });
  },
});

Deno.test({
  name: "stageYurtimg applies the image's directory modes",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const mk = await stagedKernel();
    if (!mk) return;
    assertEquals(statMode(mk, "/etc"), 0o755);
    assertEquals(statMode(mk, "/"), 0o755);
    assertEquals(statMode(mk, "/bin"), 0o755);
    assertEquals(statMode(mk, "/home/user"), 0o755);
    assertEquals(statMode(mk, "/tmp"), 0o1777);
  },
});

Deno.test({
  name: "stageYurtimg applies the image's file modes (pip launcher is 0755)",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const mk = await stagedKernel();
    if (!mk) return;
    // A `#!/usr/local/bin/python3` script, not wasm: it used to keep the
    // ramfs default 0644 and fail exec with EACCES (yurtos-kernel#3611).
    assertEquals(statMode(mk, "/usr/local/bin/pip"), 0o755);
    assertEquals(statOwner(mk, "/usr/local/bin/pip"), { uid: 0, gid: 0 });
  },
});

// --- A fake kernel: what stageYurtimg asks for, and in which order. ---

const KERNEL_VFS_SET_METADATA = 33;
const SYS_CHOWN = 0x1_0023;
const SYS_LCHOWN = 0x1_01D2;

type TarSpec = {
  path: string;
  type: "0" | "1" | "2" | "5";
  mode: number;
  uid: number;
  gid: number;
  mtime: number;
  body?: string;
  link?: string;
};

function octal(block: Uint8Array, at: number, len: number, value: number) {
  const text = value.toString(8).padStart(len - 1, "0");
  block.set(new TextEncoder().encode(text), at);
}

/** A minimal ustar archive: what the image's tar index reads. */
function ustar(entries: TarSpec[]): Uint8Array {
  const blocks: Uint8Array[] = [];
  const enc = new TextEncoder();
  for (const entry of entries) {
    const body = enc.encode(entry.body ?? "");
    const header = new Uint8Array(512);
    header.set(enc.encode(entry.path.replace(/^\//, "")), 0);
    octal(header, 100, 8, entry.mode);
    octal(header, 108, 8, entry.uid);
    octal(header, 116, 8, entry.gid);
    octal(header, 124, 12, body.byteLength);
    octal(header, 136, 12, entry.mtime);
    header.set(enc.encode(entry.type), 156);
    if (entry.link) header.set(enc.encode(entry.link), 157);
    header.set(enc.encode("ustar\0"), 257);
    header.set(enc.encode("00"), 263);
    blocks.push(header);
    const padded = new Uint8Array(Math.ceil(body.byteLength / 512) * 512);
    padded.set(body);
    blocks.push(padded);
  }
  blocks.push(new Uint8Array(1024));
  const out = new Uint8Array(blocks.reduce((n, b) => n + b.byteLength, 0));
  let at = 0;
  for (const block of blocks) {
    out.set(block, at);
    at += block.byteLength;
  }
  return out;
}

/** A zstd frame of raw (stored) blocks: a valid `.yurtimg` without a
 * compressor. */
function zstdStored(bytes: Uint8Array): Uint8Array {
  const MAX_BLOCK = 128 * 1024;
  const blockCount = Math.max(1, Math.ceil(bytes.byteLength / MAX_BLOCK));
  const out = new Uint8Array(4 + 1 + 8 + blockCount * 3 + bytes.byteLength);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0xFD2FB528, true);
  out[4] = 0xE0; // 8-byte content size, single segment, no checksum
  view.setBigUint64(5, BigInt(bytes.byteLength), true);
  let at = 13;
  for (let i = 0; i < blockCount; i++) {
    const chunk = bytes.subarray(i * MAX_BLOCK, (i + 1) * MAX_BLOCK);
    const last = i === blockCount - 1 ? 1 : 0;
    const header = (chunk.byteLength << 3) | last; // block type 0: raw
    out[at] = header & 0xff;
    out[at + 1] = (header >> 8) & 0xff;
    out[at + 2] = (header >> 16) & 0xff;
    out.set(chunk, at + 3);
    at += 3 + chunk.byteLength;
  }
  return out;
}

type Call = { kind: string; path: string };
type Recorded = { mode: number; uid: number; gid: number; mtimeNs: bigint };

function fakeKernel() {
  const decoder = new TextDecoder();
  const calls: Call[] = [];
  const metadata = new Map<string, Recorded>();
  const mk = {
    scratchLen: 64 * 1024,
    syscall(method: number, request: Uint8Array): { rc: bigint } {
      const view = new DataView(
        request.buffer,
        request.byteOffset,
        request.byteLength,
      );
      switch (method) {
        case METHOD.KERNEL_SET_PROCESS_CREDENTIALS:
          return { rc: 0n };
        case METHOD.KERNEL_FS_MKDIR:
          calls.push({ kind: "mkdir", path: decoder.decode(request) });
          return { rc: 0n };
        case METHOD.KERNEL_FS_SYMLINK: {
          const targetLen = view.getUint32(0, true);
          calls.push({
            kind: "symlink",
            path: decoder.decode(request.subarray(4 + targetLen)),
          });
          return { rc: 0n };
        }
        case SYS_CHOWN:
        case SYS_LCHOWN:
          calls.push({
            kind: "chown",
            path: decoder.decode(request.subarray(8)),
          });
          return { rc: 0n };
        case KERNEL_VFS_SET_METADATA: {
          const path = decoder.decode(request.subarray(20));
          calls.push({ kind: "metadata", path });
          metadata.set(path, {
            mode: view.getUint32(0, true),
            uid: view.getUint32(4, true),
            gid: view.getUint32(8, true),
            mtimeNs: view.getBigUint64(12, true),
          });
          return { rc: 0n };
        }
      }
      throw new Error(`unexpected syscall ${method}`);
    },
    registerRamfsFile(path: Uint8Array): void {
      calls.push({ kind: "file", path: decoder.decode(path) });
    },
    registerRamfsFileChunk(path: Uint8Array, offset: number): void {
      if (offset === 0) {
        calls.push({ kind: "file", path: decoder.decode(path) });
      }
    },
  };
  return { mk: mk as unknown as KernelHostInterface, calls, metadata };
}

const IMAGE: TarSpec[] = [
  { path: "/root", type: "5", mode: 0o700, uid: 0, gid: 0, mtime: 11 },
  {
    path: "/root/secret",
    type: "0",
    mode: 0o600,
    uid: 0,
    gid: 0,
    mtime: 12,
    body: "s\n",
  },
  { path: "/usr", type: "5", mode: 0o755, uid: 0, gid: 0, mtime: 13 },
  { path: "/usr/local", type: "5", mode: 0o755, uid: 0, gid: 0, mtime: 14 },
  { path: "/usr/local/bin", type: "5", mode: 0o755, uid: 0, gid: 0, mtime: 15 },
  {
    path: "/usr/local/bin/pip",
    type: "0",
    mode: 0o755,
    uid: 0,
    gid: 0,
    mtime: 16,
    body: "#!/usr/local/bin/python3\n",
  },
  {
    path: "/usr/local/bin/pip3",
    type: "2",
    mode: 0o777,
    uid: 0,
    gid: 0,
    mtime: 17,
    link: "pip",
  },
  {
    path: "/usr/local/bin/pip-hard",
    type: "1",
    mode: 0o755,
    uid: 0,
    gid: 0,
    mtime: 18,
    link: "usr/local/bin/pip",
  },
  { path: "/home", type: "5", mode: 0o755, uid: 0, gid: 0, mtime: 19 },
  {
    path: "/home/user",
    type: "5",
    mode: 0o750,
    uid: 1000,
    gid: 1000,
    mtime: 20,
  },
  {
    path: "/home/user/notes",
    type: "0",
    mode: 0o640,
    uid: 1000,
    gid: 1000,
    mtime: 21,
    body: "n\n",
  },
];

const TYPE_BITS: Record<TarSpec["type"], number> = {
  "0": 0o100_000,
  "1": 0o100_000,
  "2": 0o120_000,
  "5": 0o040_000,
};

Deno.test("stageYurtimg applies every entry's recorded mode, owner and mtime after structure", async () => {
  const { mk, calls, metadata } = fakeKernel();
  await stageYurtimg(mk, zstdStored(ustar(IMAGE)), new Map());

  for (const entry of IMAGE) {
    assertEquals(
      metadata.get(entry.path),
      {
        mode: TYPE_BITS[entry.type] | entry.mode,
        uid: entry.uid,
        gid: entry.gid,
        mtimeNs: BigInt(entry.mtime) * 1_000_000_000n,
      },
      `metadata for ${entry.path}`,
    );
  }
  assertEquals(metadata.get("/usr/local/bin/pip")?.mode, 0o100_755);
  assertEquals(metadata.get("/root/secret")?.mode, 0o100_600);
  // Every structural call precedes the first metadata call: a recorded
  // root-owned 0700 directory applied early would refuse what is staged
  // beneath it.
  const first = calls.findIndex((call) => call.kind === "metadata");
  assert(first > 0, "no metadata was applied");
  assert(
    calls.slice(first).every((call) => call.kind === "metadata"),
    `structure staged after metadata: ${JSON.stringify(calls)}`,
  );
});

Deno.test("stageYurtimg applies metadata only to the entries it stages", async () => {
  const { mk, metadata } = fakeKernel();
  await stageYurtimg(
    mk,
    zstdStored(ustar(IMAGE)),
    new Map(),
    (path) => path === "/usr/local/bin/pip",
  );
  assertEquals(metadata.get("/usr/local/bin/pip")?.mode, 0o100_755);
  assertEquals(metadata.has("/root/secret"), false);
  assertEquals(metadata.has("/usr/local/bin/pip3"), false);
  // Directories are always staged, so they always take their metadata.
  assertEquals(metadata.get("/root")?.mode, 0o040_700);
});
