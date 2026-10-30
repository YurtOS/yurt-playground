import { runInNewContext } from "node:vm";
import { assertEquals } from "@std/assert";

class FakeElement {
  dataset: Record<string, string> = {};
  hidden = false;
  href: string | undefined = undefined;
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
  // The train label starts hidden, as in index.html.
  document.getElementById("release-train").hidden = true;
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
  // By now both pins.json fetches have failed. Without a train the
  // release-notes links keep pointing at the top and the label stays hidden.
  assertEquals(elements.get("release-train")?.hidden, true);
  assertEquals(elements.get("release-train")?.textContent, "");
  assertEquals(elements.get("release-notes-link")?.href, undefined);
  assertEquals(elements.get("footer-release-notes")?.href, undefined);
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
  // The train label starts hidden, as in index.html.
  document.getElementById("release-train").hidden = true;
  runInNewContext(source, { console, crypto, document, fetch, Response });
  const deadline = Date.now() + 1_000;
  while (elements.get("release-train")?.hidden !== false) {
    if (Date.now() >= deadline) throw new Error("train was never shown");
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assertEquals(pinsFetches, 1);
  assertEquals(elements.get("release-train")?.hidden, false);
  for (const id of ["release-notes-link", "footer-release-notes"]) {
    assertEquals(
      elements.get(id)?.href,
      `https://yurtos.github.io/yurt-playground/#${train}`,
    );
    assertEquals(
      elements.get(id)?.title,
      `Release notes for train ${train}, which this page is pinned to`,
    );
  }
  assertEquals(
    elements.get("release-train")?.textContent,
    " Version 2026-10-26.",
  );
});

Deno.test("release-notes links stay on the top when pins.json names no train", async () => {
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
  let settled!: () => void;
  const fetched = new Promise<void>((resolve) => settled = resolve);
  const fetch = (input: string): Promise<Response> => {
    if (input === "./pins.json") {
      settled();
      return Promise.resolve(Response.json({ kernelWasm: {} }));
    }
    return Promise.reject(new Error(`unexpected fetch ${input}`));
  };
  const source = await Deno.readTextFile(
    new URL("../public/verify.js", import.meta.url),
  );
  document.getElementById("release-train").hidden = true;
  runInNewContext(source, { console, crypto, document, fetch, Response });
  await fetched;
  // Let showTrain() finish reading the response.
  for (let i = 0; i < 20; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assertEquals(elements.get("release-train")?.hidden, true);
  assertEquals(elements.get("release-notes-link")?.href, undefined);
  assertEquals(elements.get("footer-release-notes")?.href, undefined);
});

Deno.test("the footer's version is the train's date, with its .N suffix", async () => {
  const source = await Deno.readTextFile(
    new URL("../public/verify.js", import.meta.url),
  );
  const document = {
    getElementById: () => new FakeElement(),
    createElement: () => new FakeElement(),
  };
  // No pins: showTrain() gives up, and the context keeps trainVersion.
  const fetch = () => Promise.reject(new Error("offline"));
  const context: Record<string, unknown> = { console, document, fetch };
  runInNewContext(source, context);
  const trainVersion = context.trainVersion as (train: string) => string;
  assertEquals(trainVersion("playground-2026.10.29-3d32068"), "2026-10-29");
  assertEquals(trainVersion("playground-2026.10.27-3d32068.2"), "2026-10-27.2");
  assertEquals(trainVersion("local-build"), "local-build");
});
