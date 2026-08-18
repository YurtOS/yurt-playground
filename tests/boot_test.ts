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

async function typeCommand(term: MemoryTerm, command: string): Promise<string> {
  const before = term.output().length;
  term.type(command.endsWith("\n") ? command : `${command}\n`);
  let last = "";
  const start = Date.now();
  while (Date.now() - start < 10_000) {
    await new Promise((r) => setTimeout(r, 80));
    const added = term.output().slice(before);
    if (
      added === last &&
      added.includes(command.replace(/\n$/, "")) &&
      /\$ $/.test(added.replace(/\r/g, ""))
    ) {
      return added;
    }
    last = added;
  }
  throw new Error(
    `prompt after ${JSON.stringify(command)} in ${
      JSON.stringify(term.output())
    }`,
  );
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

Deno.test({
  name: "bootPlayground attaches ash and echoes through the PTY",
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
      term.type("pwd\n");
      await waitFor(
        () => term.output().includes("/home/user"),
        `pwd in ${JSON.stringify(term.output())}`,
      );
      term.type("ls -ld /bin\n");
      await waitFor(
        () => /root\s+root/.test(term.output()),
        `ls -ld /bin in ${JSON.stringify(term.output())}`,
      );

      // ash `>` and hidden names: `ls -l` omits dotfiles (Linux).
      await typeCommand(term, "echo xxx > visible");
      await typeCommand(term, "echo yyy > .hidden");
      const listing = await typeCommand(term, "ls -l");
      if (!/-rw-r--r--\s+1 user\s+user\s+4 .*visible/.test(listing)) {
        throw new Error(`ls -l missing visible: ${JSON.stringify(listing)}`);
      }
      if (listing.includes(".hidden")) {
        throw new Error(`ls -l showed hidden file: ${JSON.stringify(listing)}`);
      }
      const all = await typeCommand(term, "ls -la");
      if (!/-rw-r--r--\s+1 user\s+user\s+4 .*\.hidden/.test(all)) {
        throw new Error(`ls -la missing .hidden: ${JSON.stringify(all)}`);
      }
      const cats = await typeCommand(
        term,
        "cat visible; echo --; cat .hidden; echo ENDCAT",
      );
      if (!/xxx[\r\n]+--[\r\n]+yyy[\r\n]+ENDCAT/.test(cats)) {
        throw new Error(`redirect contents: ${JSON.stringify(cats)}`);
      }
    } finally {
      session.stop();
    }
  },
});
