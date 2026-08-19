import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { bootPlayground, type PlaygroundTerm } from "../src/boot.ts";
import { handlePlaygroundRequest } from "../src/serve.ts";
import { loadPins, resolveArtifacts } from "../src/pins.ts";

export const repoRoot = join(fileURLToPath(import.meta.url), "../..");

export type MemoryTerm = PlaygroundTerm & {
  type: (data: string) => void;
  output: () => string;
};

export function memoryTerm(): MemoryTerm {
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

export async function fetchViaHandler(path: string): Promise<Uint8Array> {
  const url = path.startsWith("./") ? path.slice(1) : path;
  const res = await handlePlaygroundRequest(
    new Request(`http://playground${url}`),
  );
  if (!res.ok) {
    throw new Error(`fetch ${path} failed: ${res.status}`);
  }
  return new Uint8Array(await res.arrayBuffer());
}

export async function waitFor(
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

let markerSeq = 0;

/** Type a command and wait for a unique marker so a stale `$ ` cannot match. */
export async function typeCommand(
  term: MemoryTerm,
  command: string,
  timeoutMs = 10_000,
): Promise<string> {
  const marker = `__YURT_${++markerSeq}__`;
  const before = term.output().length;
  term.type(`${command}; echo ${marker}\n`);
  await waitFor(
    () => {
      const added = term.output().slice(before).replace(/\r/g, "");
      return added.split("\n").some((line) => line.trim() === marker) &&
        /\$ $/.test(added);
    },
    `marker ${marker} after ${JSON.stringify(command)} in ${
      JSON.stringify(term.output())
    }`,
    timeoutMs,
  );
  return term.output().slice(before);
}

export async function resolvePlaygroundArtifacts(
  requireArtifacts = false,
): Promise<boolean> {
  const artifactsDir = join(repoRoot, "artifacts");
  try {
    await resolveArtifacts({
      artifactsDir,
      pins: await loadPins(join(artifactsDir, "pins.json")),
      kernelRoot: Deno.env.get("YURT_KERNEL_ROOT") ??
        join(repoRoot, "../yurtos-kernel"),
      portsRoot: Deno.env.get("YURT_PORTS_ROOT"),
    });
    return true;
  } catch (error) {
    if (requireArtifacts) throw error;
    console.log(
      `skipping ash session: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return false;
  }
}

export type AshSession = {
  term: MemoryTerm;
  shown: () => string;
  stop: () => void;
};

export type AshSessionOptions = {
  requireArtifacts?: boolean;
};

export async function bootAshSession(
  options: AshSessionOptions = {},
): Promise<AshSession | undefined> {
  if (!await resolvePlaygroundArtifacts(options.requireArtifacts)) {
    return undefined;
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
  await waitFor(
    () => /[$#]/.test(term.output()) || term.output().length > 0,
    `ash prompt, shown=${JSON.stringify(shown)} out=${
      JSON.stringify(term.output())
    }`,
  );
  return {
    term,
    shown: () => shown,
    stop: () => session.stop(),
  };
}

export function assertNoTouchFailure(output: string, label: string): void {
  if (
    output.includes("No child process") ||
    output.includes("Operation not permitted")
  ) {
    throw new Error(`${label} failed: ${JSON.stringify(output)}`);
  }
}
