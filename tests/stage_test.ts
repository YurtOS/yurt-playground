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

function statRecord(mk: KernelHostInterface, path: string): DataView {
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
  return view;
}

function statOwner(
  mk: KernelHostInterface,
  path: string,
): { uid: number; gid: number } {
  const view = statRecord(mk, path);
  return {
    uid: view.getUint32(STAT_UID, true),
    gid: view.getUint32(STAT_GID, true),
  };
}

function statPermissions(mk: KernelHostInterface, path: string): number {
  return statRecord(mk, path).getUint32(STAT_MODE, true) & 0o7777;
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

async function run(command: string, args: string[]): Promise<void> {
  const { success, stderr } = await new Deno.Command(command, {
    args,
    stderr: "piped",
  }).output();
  if (!success) throw new Error(new TextDecoder().decode(stderr));
}

Deno.test({
  name: "stageYurtimg keeps the permission bits recorded in the image",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const kernelWasm = join(
      Deno.env.get("YURT_KERNEL_ROOT") ?? join(repoRoot, "../yurtos-kernel"),
      "target/kernel-wasm/release/yurt_kernel.wasm",
    );
    let kernel: Uint8Array;
    try {
      kernel = await Deno.readFile(kernelWasm);
      await run("zstd", ["--version"]);
    } catch (error) {
      console.log(
        `skipping stage modes: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return;
    }
    // A shell script is only runnable if its execute bit survives staging.
    const dir = await Deno.makeTempDir();
    try {
      await Deno.mkdir(join(dir, "bin"));
      await Deno.mkdir(join(dir, "etc"));
      await Deno.mkdir(join(dir, "root"));
      await Deno.writeTextFile(join(dir, "bin/tool.sh"), "#!/bin/sh\n");
      await Deno.writeTextFile(join(dir, "etc/plain.txt"), "x\n");
      await Deno.writeTextFile(join(dir, "root/secret"), "s\n");
      await Deno.chmod(join(dir, "bin/tool.sh"), 0o754);
      await Deno.chmod(join(dir, "etc/plain.txt"), 0o640);
      await Deno.chmod(join(dir, "root/secret"), 0o600);
      await Deno.chmod(join(dir, "root"), 0o700);
      // No `./` root member: the loader rejects a tar that duplicates "/".
      await run("tar", [
        "-cf",
        join(dir, "img.tar"),
        "-C",
        dir,
        "bin",
        "etc",
        "root",
      ]);
      await run("zstd", [
        "-q",
        "-f",
        join(dir, "img.tar"),
        "-o",
        join(dir, "img.zst"),
      ]);
      const mk = await KernelHostInterface.load(kernel, defaultHostState());
      await stageYurtimg(
        mk,
        await Deno.readFile(join(dir, "img.zst")),
        new Map(),
      );
      assertEquals(statPermissions(mk, "/bin/tool.sh"), 0o754);
      assertEquals(statPermissions(mk, "/etc/plain.txt"), 0o640);
      assertEquals(statPermissions(mk, "/root/secret"), 0o600);
      assertEquals(statPermissions(mk, "/root"), 0o700);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});
