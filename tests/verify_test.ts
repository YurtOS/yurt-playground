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
  // Without pins.json the release-notes links keep pointing at the top.
  assertEquals(elements.get("release-train")?.hidden ?? true, true);
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

Deno.test("release-notes links point at the train named in pins.json", async () => {
  const elements = new Map<
    string,
    FakeElement & { href?: string; title?: string }
  >();
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
  const train = "playground-2026.10.26-3d32068";
  let pinsFetches = 0;
  const fetch = (input: string): Promise<Response> => {
    if (input === "./pins.json") {
      pinsFetches += 1;
      return Promise.resolve(Response.json({ train }));
    }
    return Promise.reject(new Error(`unexpected fetch ${input}`));
  };
  const source = await Deno.readTextFile(
    new URL("../public/verify.js", import.meta.url),
  );
  runInNewContext(source, { console, crypto, document, fetch, Response });
  const deadline = Date.now() + 1_000;
  while (elements.get("release-train")?.hidden !== false) {
    if (Date.now() >= deadline) throw new Error("train was never shown");
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assertEquals(pinsFetches, 1);
  for (const id of ["release-notes-link", "footer-release-notes"]) {
    assertEquals(
      elements.get(id)?.href,
      `https://yurtos.github.io/yurt-playground/#${train}`,
    );
    assertEquals(elements.get(id)?.title, `This page runs train ${train}`);
  }
  assertEquals(
    elements.get("release-train")?.textContent,
    ` (this page runs ${train})`,
  );
});
