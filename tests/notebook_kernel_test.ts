/**
 * The suspend/resume notebook kernel's guest half, on the JS host in Deno:
 * the sealable CPython runs `cell_server.py` over a raw pty, a cell that
 * prints primes is sealed mid-loop, the sandbox is torn down, and the restore
 * continues the loop at the next prime. Needs the pinned blobs and
 * public/demo/python3-seal.wasm (scripts/build-python-seal.sh); skips
 * without them unless PLAYGROUND_REQUIRE_ARTIFACTS is set.
 */
import { assert, assertEquals } from "@std/assert";
import { join } from "node:path";
import {
  defaultHostState,
  KernelHostInterface,
  pumpPtyMaster,
  s,
} from "@yurt/kernel-host-interface-js";
import { PYTHON_SEAL_NAME } from "../src/image_parts.ts";
import { stagedPath } from "../src/notebook_stage.ts";
import { stageYurtimg, writeRamfsFile } from "../src/stage.ts";
import { fetchViaHandler, repoRoot, waitFor } from "./ash_harness.ts";

const PRIMES = `import time
n, found = 1, 0
while True:
    n += 1
    if all(n % p for p in range(2, int(n ** 0.5) + 1)):
        found += 1
        print(f"prime #{found} = {n}", flush=True)
        time.sleep(0.1)
`;

async function readOptional(path: string): Promise<Uint8Array | undefined> {
  try {
    return await Deno.readFile(path);
  } catch {
    return undefined;
  }
}

Deno.test("the notebook kernel's CPython seals mid-cell and resumes at the next prime", async () => {
  const guest = await readOptional(join(repoRoot, "public", PYTHON_SEAL_NAME));
  let kernel: Uint8Array | undefined;
  let image: Uint8Array | undefined;
  try {
    kernel = await fetchViaHandler("./yurt_kernel.wasm");
    image = await fetchViaHandler("./playground.yurtimg");
  } catch { /* no pinned blobs */ }
  if (guest === undefined || kernel === undefined || image === undefined) {
    if (Deno.env.get("PLAYGROUND_REQUIRE_ARTIFACTS")) {
      throw new Error("the notebook kernel test needs the blobs");
    }
    console.log("skipped: needs the pinned blobs and python3-seal.wasm");
    return;
  }
  const server = await Deno.readFile(
    join(repoRoot, "public/demo/cell_server.py"),
  );
  const mk = await KernelHostInterface.load(kernel, defaultHostState());
  await stageYurtimg(mk, image, new Map(), stagedPath);
  writeRamfsFile(mk, "/usr/local/yurt/cell_server.py", server);

  let out = "";
  const primes = () => (out.match(/prime #/g) ?? []).length;
  const process = await mk.spawnUserProcessWithArgsAsync(guest, [
    s("python3"),
    s("/usr/local/yurt/cell_server.py"),
  ], { PYTHONHOME: "/usr/local", PYTHONDONTWRITEBYTECODE: "1", TERM: "dumb" });
  const pty = mk.attachHostPty(process.pid);
  const stopPump = pumpPtyMaster(mk, pty, (bytes) => {
    out += new TextDecoder().decode(bytes);
  });
  process.runStartAsync().catch(() => {});
  await waitFor(() => out.includes('"ready"'), "the cell server", 180_000);
  mk.ptyMasterWrite(
    pty,
    new TextEncoder().encode(
      JSON.stringify({ t: "exec", code: PRIMES }) + "\n",
    ),
  );
  await waitFor(() => primes() >= 5, "five primes", 60_000);

  const sealed = await mk.sealSandbox({ deadlineMs: 20_000 });
  // Only the stdlib is staged: with the whole image the kernel's memory
  // (the ramfs) would be ~400 MB, copied on every seal.
  assert(sealed.kernelMemory.byteLength < 64 * 1024 * 1024);
  stopPump();
  mk.killProcess(process.pid, 9);
  mk.dispose();
  const before = primes();
  const lastBefore = out.match(/prime #(\d+) = (\d+)/g)?.at(-1);

  const restored = await KernelHostInterface.restore(
    kernel,
    sealed,
    defaultHostState(),
  );
  const [resumed] = restored.processes;
  const stopResumed = pumpPtyMaster(restored.host, pty, (bytes) => {
    out += new TextDecoder().decode(bytes);
  });
  resumed.runStartAsync().catch(() => {});
  try {
    await waitFor(() => primes() >= before + 3, "primes after restore", 60_000);
  } finally {
    stopResumed();
    restored.host.killProcess(resumed.pid, 9);
    restored.host.dispose();
  }
  // The loop continued, not restarted: the numbering runs on from the seal.
  const all = [...out.matchAll(/prime #(\d+) = (\d+)/g)].map((m) =>
    Number(m[1])
  );
  assertEquals(all, all.map((_, i) => i + 1));
  assert(
    lastBefore !== undefined &&
      out.indexOf(lastBefore) === out.lastIndexOf(lastBefore),
  );
});
