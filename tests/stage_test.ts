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

function statOwner(
  mk: KernelHostInterface,
  path: string,
): { uid: number; gid: number } {
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
  const view = new DataView(stat.buffer, stat.byteOffset, stat.byteLength);
  mk.syscall(METHOD.KERNEL_FS_CLOSE, fdBytes, 0);
  return {
    uid: view.getUint32(STAT_UID, true),
    gid: view.getUint32(STAT_GID, true),
  };
}

Deno.test({
  name:
    "stageYurtimg applies tar owners so /home is root and /home/user is 1000",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
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
        `skipping stage owners: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return;
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

    assertEquals(statOwner(mk, "/bin"), { uid: 0, gid: 0 });
    assertEquals(statOwner(mk, "/home"), { uid: 0, gid: 0 });
    assertEquals(statOwner(mk, "/home/user"), { uid: 1000, gid: 1000 });
  },
});
