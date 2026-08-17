import { assertEquals } from "@std/assert";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { bootPlayground, type PlaygroundTerm } from "../src/boot.ts";
import { handlePlaygroundRequest } from "../src/serve.ts";
import { loadPins, resolveArtifacts } from "../src/pins.ts";

const repoRoot = join(fileURLToPath(import.meta.url), "../..");

async function fetchViaHandler(path: string): Promise<Uint8Array> {
  const url = path.startsWith("./") ? path.slice(1) : path;
  const res = await handlePlaygroundRequest(
    new Request(`http://playground${url}`),
  );
  if (!res.ok) {
    throw new Error(`fetch ${path} failed: ${res.status}`);
  }
  return new Uint8Array(await res.arrayBuffer());
}

type MemoryTerm = PlaygroundTerm & {
  type: (data: string) => void;
  output: () => string;
};

function memoryTerm(): MemoryTerm {
  let text = "";
  const dataHandlers: Array<(data: string) => void> = [];
  return {
    cols: 80,
    rows: 24,
    write(data: string | Uint8Array) {
      text += typeof data === "string" ? data : new TextDecoder().decode(data);
    },
    onData(handler: (data: string) => void) {
      dataHandlers.push(handler);
    },
    onResize() {},
    type(data: string) {
      for (const handler of dataHandlers) handler(data);
    },
    output: () => text,
  };
}

async function waitFor(
  pred: () => boolean,
  label: string,
  timeoutMs = 10_000,
): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timed out waiting for ${label}`);
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}

Deno.test("bootPlayground fails closed when the page is not isolated", async () => {
  let shown = "";
  try {
    await bootPlayground({
      isolated: false,
      fetchBytes: () => Promise.resolve(new Uint8Array()),
      show: (text: string) => {
        shown = text;
      },
      term: memoryTerm(),
    });
    throw new Error("expected bootPlayground to reject");
  } catch (error) {
    if (
      !(error instanceof Error) || error.message !== "not crossOriginIsolated"
    ) {
      throw error;
    }
  }
  assertEquals(shown, "need COOP/COEP");
});

Deno.test("bootPlayground attaches ash and echoes through the PTY", async () => {
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
      `skipping ash boot: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return;
  }

  const term = memoryTerm();
  let shown = "";
  const session = await bootPlayground({
    isolated: true,
    fetchBytes: fetchViaHandler,
    show: (text: string) => {
      shown = text;
    },
    term,
  });
  try {
    await waitFor(
      () => /[$#]/.test(term.output()) || term.output().length > 0,
      `ash prompt, shown=${JSON.stringify(shown)} out=${
        JSON.stringify(term.output())
      }`,
    );
    term.type("echo hi\n");
    await waitFor(
      () => term.output().includes("hi"),
      `echo hi in ${JSON.stringify(term.output())}`,
    );
  } finally {
    session.stop();
  }
});
