import { assertEquals } from "@std/assert";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  defaultHostState,
  KernelHostInterface,
  METHOD,
} from "@yurt/kernel-host-interface-js";
import { handlePlaygroundRequest } from "../src/serve.ts";
import { loadPins, resolveArtifacts } from "../src/pins.ts";
import { ownershipMethodForEntry, stageYurtimg } from "../src/stage.ts";

const STAT_MODE = 12;
const STAT_UID = 16;
const STAT_GID = 20;
const STAT_LEN = 48;

const repoRoot = join(fileURLToPath(import.meta.url), "../..");

Deno.test("symlink ownership uses no-follow lchown", () => {
  assertEquals(ownershipMethodForEntry("symlink"), 0x1_01D2);
  assertEquals(ownershipMethodForEntry("file"), 0x1_0023);
  assertEquals(ownershipMethodForEntry("dir"), 0x1_0023);
});

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

/** A kernel with the pinned image staged into it, or `null` when the
 * artifacts are not resolvable here (the same skip the owners test uses:
 * this needs the real image, not a fixture). */
async function stagedKernel(): Promise<KernelHostInterface | null> {
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
    console.log(
      `skipping staged-kernel test: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
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
  name: "stageYurtimg applies the tar's directory modes, so /etc is not 0777",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const mk = await stagedKernel();
    if (!mk) return;
    // What the image carries, and what `ls -ld` showed in the shipped
    // playground: `/` and `/etc` are the directories the kernel's boot ramfs
    // pre-creates, so before this they kept its 0o777 default while `/bin`,
    // created by the staging itself, got 0o755 from the umask
    // (yurt-ports#102).
    assertEquals(statMode(mk, "/etc"), 0o755);
    assertEquals(statMode(mk, "/"), 0o755);
    assertEquals(statMode(mk, "/bin"), 0o755);
    assertEquals(statMode(mk, "/home/user"), 0o755);
    // The one that is meant to be world-writable keeps its sticky bit.
    assertEquals(statMode(mk, "/tmp"), 0o1777);
  },
});
