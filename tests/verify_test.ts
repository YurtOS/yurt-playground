import { runInNewContext } from "node:vm";
import { assertEquals } from "@std/assert";

class FakeElement {
  dataset: Record<string, string> = {};
  hidden = false;
  disabled = false;
  textContent = "";
  className = "";
  children: FakeElement[] = [];
  #listeners = new Map<string, () => void>();

  addEventListener(type: string, listener: () => void): void {
    this.#listeners.set(type, listener);
  }

  append(...children: FakeElement[]): void {
    this.children.push(...children);
  }

  replaceChildren(...children: FakeElement[]): void {
    this.children = children;
  }

  click(): void {
    this.#listeners.get("click")?.();
  }
}

Deno.test("verifier does not pass required files when release pins cannot be fetched", async () => {
  const elements = new Map<string, FakeElement>();
  const document = {
    getElementById(id: string): FakeElement {
      const element = elements.get(id) ?? new FakeElement();
      elements.set(id, element);
      return element;
    },
    createElement(): FakeElement {
      return new FakeElement();
    },
  };
  const bytes = new TextEncoder().encode("fixture");
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hash = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  const files = [
    "boot.bundle.js",
    "coordinator.bundle.js",
    "worker_bootstrap.js",
    "playground-bridge.js",
    "yurt_kernel.wasm",
    "playground.yurtimg",
  ];
  const manifest = {
    commit: null,
    files: Object.fromEntries(files.map((name) => [name, hash])),
  };
  const fetch = (input: string): Promise<Response> => {
    if (input === "./integrity.json") {
      return Promise.resolve(Response.json(manifest));
    }
    if (input === "./pins.json") {
      return Promise.reject(new Error("pins unavailable"));
    }
    if (input.endsWith(".parts.json")) {
      return Promise.resolve(
        Response.json({ size: bytes.byteLength, parts: ["part0"] }),
      );
    }
    return Promise.resolve(new Response(bytes));
  };
  const source = await Deno.readTextFile(
    new URL("../public/verify.js", import.meta.url),
  );
  const context = {
    console,
    crypto,
    document,
    fetch,
    Response,
    TextEncoder,
    Uint8Array,
  };
  runInNewContext(source, context);
  elements.get("verify-files")!.click();
  await new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + 1_000;
    const poll = () => {
      const summary = elements.get("verify-results")?.children[0].textContent;
      if (summary?.endsWith("files match.")) {
        resolve();
      } else if (Date.now() >= deadline) {
        reject(new Error(`verification did not finish: ${summary}`));
      } else {
        setTimeout(poll, 0);
      }
    };
    poll();
  });

  assertEquals(
    elements.get("verify-results")?.children[0].textContent,
    "4 of 6 files match.",
  );
});
