/**
 * The suspend/resume notebook kernel's guest half, on the JS host in Deno:
 * the sealable CPython runs `cell_server.py` over a raw pty, a cell that
 * prints primes is sealed mid-loop, the sandbox is torn down, and the restore
 * continues the loop at the next prime. Needs the pinned blobs and
 * public/demo/python3-seal.wasm (scripts/install-pinned-artifacts.sh); skips
 * without them unless PLAYGROUND_REQUIRE_ARTIFACTS is set.
 */
import { assert, assertEquals, assertThrows } from "@std/assert";
import { join } from "node:path";
import {
  defaultHostState,
  KernelHostInterface,
  pumpPtyMaster,
  s,
  type UserProcess,
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

/** The cell server booted on the JS host, past its "ready" frame. */
interface CellServer {
  kernel: Uint8Array;
  host: KernelHostInterface;
  pty: number;
  process: UserProcess;
  /** Everything the pty has printed; the pump appends to it. */
  out: string;
  stopPump: () => void;
}

/**
 * Stages the image and `cell_server.py`, starts the sealable CPython on a raw
 * pty, and waits for "ready". Returns undefined when the blobs are absent,
 * which fails instead when PLAYGROUND_REQUIRE_ARTIFACTS is set.
 */
async function bootCellServer(): Promise<CellServer | undefined> {
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
    return undefined;
  }
  const server = await Deno.readFile(
    join(repoRoot, "public/demo/cell_server.py"),
  );
  const host = await KernelHostInterface.load(kernel, defaultHostState());
  await stageYurtimg(host, image, new Map(), stagedPath);
  writeRamfsFile(host, "/usr/local/yurt/cell_server.py", server);
  const process = await host.spawnUserProcessWithArgsAsync(guest, [
    s("python3"),
    s("/usr/local/yurt/cell_server.py"),
  ], {
    PYTHONHOME: "/usr/local",
    PYTHONDONTWRITEBYTECODE: "1",
    TERM: "dumb",
  });
  const pty = host.attachHostPty(process.pid);
  const booted: CellServer = {
    kernel,
    host,
    pty,
    process,
    out: "",
    stopPump: () => {},
  };
  booted.stopPump = pumpPtyMaster(host, pty, (bytes) => {
    booted.out += new TextDecoder().decode(bytes);
  });
  process.runStartAsync().catch(() => {});
  try {
    await waitFor(
      () => booted.out.includes('"ready"'),
      "the cell server",
      180_000,
    );
  } catch (error) {
    booted.stopPump();
    host.killProcess(process.pid, 9);
    host.dispose();
    throw error;
  }
  return booted;
}

Deno.test({
  name:
    "the notebook kernel's CPython seals mid-cell and resumes at the next prime",
  // Like the other tests that boot a host: the killed guest's exit and the
  // host's own timers settle after the test body, later on a slow runner.
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const booted = await bootCellServer();
    if (booted === undefined) return;
    const { kernel, host: mk, pty, process } = booted;
    const primes = () => (booted.out.match(/prime #/g) ?? []).length;
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
    booted.stopPump();
    mk.killProcess(process.pid, 9);
    mk.dispose();
    const before = primes();
    const lastBefore = booted.out.match(/prime #(\d+) = (\d+)/g)?.at(-1);

    const restored = await KernelHostInterface.restore(
      kernel,
      sealed,
      defaultHostState(),
    );
    const [resumed] = restored.processes;
    const stopResumed = pumpPtyMaster(restored.host, pty, (bytes) => {
      booted.out += new TextDecoder().decode(bytes);
    });
    resumed.runStartAsync().catch(() => {});
    try {
      await waitFor(
        () => primes() >= before + 3,
        "primes after restore",
        60_000,
      );
    } finally {
      stopResumed();
      restored.host.killProcess(resumed.pid, 9);
      restored.host.dispose();
    }
    // The loop continued, not restarted: the numbering runs on from the seal.
    const all = [...booted.out.matchAll(/prime #(\d+) = (\d+)/g)].map((m) =>
      Number(m[1])
    );
    assertEquals(all, all.map((_, i) => i + 1));
    assert(
      lastBefore !== undefined &&
        booted.out.indexOf(lastBefore) === booted.out.lastIndexOf(lastBefore),
    );
  },
});

interface ErrorFrame {
  ename: string;
  traceback: string[];
}

/**
 * The error frames in a pty transcript, one JSON object per line. The pump
 * hands over chunks, not lines, so an unfinished trailing segment is ignored
 * until its "\n" arrives: parsing a partial frame throws, and inside waitFor's
 * predicate that fails the test instead of polling again. A malformed finished
 * line still throws.
 */
function errorFrames(out: string): Array<ErrorFrame> {
  const lines = out.split("\n");
  if (!out.endsWith("\n")) lines.pop();
  return lines.filter((line) => line.includes('"t": "error"'))
    .map((line) => JSON.parse(line) as ErrorFrame);
}

/** A guest error frame, spaced the way the guest's json.dumps writes it. */
function errorFrame(ename: string): string {
  return `{"t": "error", "ename": "${ename}", "evalue": "", "traceback": ["Traceback (most recent call last):\\n", "  File \\"<cell>\\", line 1, in <module>\\n", "${ename}\\n"]}`;
}

Deno.test({
  name: "errorFrames reads finished frames and leaves a partial tail alone",
  // Host timers from the surrounding boot tests settle whenever the runner
  // gets to them: on CI one completed inside the 0 ms test below and tripped
  // the leak check. Sanitizers off, like every other test in this file.
  sanitizeOps: false,
  sanitizeResources: false,
  fn() {
    const done = '{"t": "done", "count": 1}';
    const first = errorFrame("ZeroDivisionError");
    const second = errorFrame("SyntaxError");
    // The pump hands over chunks, not lines: the trailing segment is partway
    // into the next frame until its "\n" arrives, marker included. Parsing it
    // would throw inside waitFor's predicate and fail the test instead of
    // polling again.
    const tail = second.slice(0, second.indexOf('"ename"'));
    assertEquals(
      errorFrames(`${first}\n${done}\n${tail}`).map((f) => f.ename),
      ["ZeroDivisionError"],
    );
    // Once the line is complete, both frames are there.
    assertEquals(
      errorFrames(`${first}\n${done}\n${second}\n`).map((f) => f.ename),
      ["ZeroDivisionError", "SyntaxError"],
    );
  },
});

Deno.test({
  name: "errorFrames throws on a finished line that is not JSON",
  sanitizeOps: false, // foreign host timers, as above
  sanitizeResources: false,
  fn() {
    // A completed line that carries the marker but does not parse means the
    // guest broke the protocol; swallowing that would hide it.
    assertThrows(() => errorFrames('{"t": "error", "ename": \n'));
  },
});

Deno.test({
  name:
    "the notebook kernel's tracebacks start at the cell, not in cell_server.py",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const booted = await bootCellServer();
    if (booted === undefined) return;
    const { host: mk, pty, process } = booted;
    const errors = () => errorFrames(booted.out);
    const run = async (code: string, interrupt = false) => {
      const seen = errors().length;
      mk.ptyMasterWrite(
        pty,
        new TextEncoder().encode(JSON.stringify({ t: "exec", code }) + "\n"),
      );
      if (interrupt) {
        await waitFor(
          () => booted.out.includes("tick"),
          "the cell to start",
          30_000,
        );
        mk.killProcess(process.pid, 2);
      }
      await waitFor(() => errors().length > seen, "the error frame", 30_000);
      return errors()[seen];
    };
    try {
      // A raise two frames deep, a syntax error, and the reported case: an
      // interrupt (yurt-ports#150).
      const raised = await run("def f():\n    1 / 0\nf()\n");
      const syntax = await run("1 +\n");
      await run('saved = ValueError("original")\nraise saved\n');
      const caused = await run('raise RuntimeError("outer") from saved\n');
      const contextual = await run(
        'try:\n    raise saved\nexcept ValueError:\n    raise RuntimeError("context")\n',
      );
      const grouped = await run('raise ExceptionGroup("group", [saved])\n');
      for (const error of [caused, contextual, grouped]) {
        const text = error.traceback.join("");
        assert(!text.includes("cell_server.py"), text);
        assert(text.includes("ValueError: original"), text);
        assert(text.includes('File "<cell>", line 2'), text);
      }
      assertEquals(caused.ename, "RuntimeError");
      assert(caused.traceback.join("").includes("direct cause"));
      assertEquals(contextual.ename, "RuntimeError");
      assert(contextual.traceback.join("").includes("During handling"));
      assertEquals(grouped.ename, "ExceptionGroup");
      const suppressed = await run(
        'try:\n    raise saved\nexcept ValueError:\n    raise RuntimeError("hidden cause") from None\n',
      );
      const suppressedText = suppressed.traceback.join("");
      assertEquals(suppressed.ename, "RuntimeError");
      assert(!suppressedText.includes("ValueError"), suppressedText);
      assert(!suppressedText.includes("cell_server.py"), suppressedText);
      const interrupted = await run(
        "import time\nprint('tick', flush=True)\nwhile True:\n    time.sleep(0.05)\n",
        true,
      );
      assertEquals(
        [raised.ename, syntax.ename, interrupted.ename],
        ["ZeroDivisionError", "SyntaxError", "KeyboardInterrupt"],
      );
      // The raise and the syntax error carry no server frames at all. An
      // interrupt may land while the cell's print is inside the server's
      // write/emit; those frames stay below the cell's, as a real traceback
      // would. The interrupt's guarantee is where it starts, asserted below.
      for (const error of [raised, syntax]) {
        const text = error.traceback.join("");
        assert(!text.includes("cell_server.py"), text);
      }
      for (const error of [raised, interrupted]) {
        assertEquals(
          error.traceback[0],
          "Traceback (most recent call last):\n",
        );
        assert(
          error.traceback[1].startsWith('  File "<cell>"'),
          error.traceback.join(""),
        );
      }
      assert(
        syntax.traceback.join("").includes('File "<cell>", line 1'),
        syntax.traceback.join(""),
      );
    } finally {
      booted.stopPump();
      mk.killProcess(process.pid, 9);
      mk.dispose();
    }
  },
});
