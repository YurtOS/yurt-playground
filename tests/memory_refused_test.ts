import { assert, assertEquals } from "@std/assert";
import {
  hideMemoryRefused,
  MEMORY_REFUSED_BANNER_ID,
  MEMORY_REFUSED_MESSAGE_TYPE,
  MEMORY_REFUSED_RELOAD_ID,
  MEMORY_REFUSED_TEXT,
  memoryRefusedMessage,
  mountMemoryRefusedBanner,
  showMemoryRefused,
  watchGuestMemoryRefusals,
} from "../src/memory_refused.ts";

/** A kernel host with the refusal hook, fired by hand. */
function fakeHost() {
  const listeners = new Set<() => void>();
  return {
    onGuestMemoryRefused(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    refuse() {
      for (const listener of [...listeners]) listener();
    },
    listeners,
  };
}

Deno.test("the page is told once, on the first refused process memory", () => {
  const host = fakeHost();
  let told = 0;
  watchGuestMemoryRefusals(host, () => told++);
  assertEquals(told, 0);
  host.refuse();
  host.refuse();
  host.refuse();
  assertEquals(told, 1);
  assertEquals(host.listeners.size, 0);
});

Deno.test("a kernel without the refusal hook is never reported", () => {
  let told = 0;
  watchGuestMemoryRefusals({}, () => told++);
  assertEquals(told, 0);
});

Deno.test("a refusal reported while subscribing is told once and unsubscribed", () => {
  const listeners = new Set<() => void>();
  const host = {
    onGuestMemoryRefused(listener: () => void) {
      listeners.add(listener);
      listener();
      return () => listeners.delete(listener);
    },
  };
  let told = 0;
  watchGuestMemoryRefusals(host, () => told++);
  assertEquals(told, 1);
  assertEquals(listeners.size, 0);
});

Deno.test("the banner is a tab-level note that names no engine", () => {
  const html = Deno.readTextFileSync(
    new URL("../public/index.html", import.meta.url),
  );
  const banner = html.match(
    /<p id="memory-refused"[^>]*>([\s\S]*?)<\/p>/,
  );
  if (banner === null) throw new Error("no #memory-refused paragraph");
  const text = banner[1].replace(/<button[\s\S]*<\/button>/, "")
    .replace(/\s+/g, " ").trim();
  // The pages that build their banner (`mountMemoryRefusedBanner`) say
  // the same words.
  assertEquals(text, MEMORY_REFUSED_TEXT);
  // Outside the terminal pane, which is overflow: hidden and scrolls away.
  assertEquals(
    html.indexOf('id="memory-refused"') < html.indexOf('class="pane"'),
    true,
  );
});

Deno.test("stopping the session stops watching: a later refusal raises nothing", () => {
  const host = fakeHost();
  let told = 0;
  const stop = watchGuestMemoryRefusals(host, () => told++);
  stop();
  stop(); // idempotent
  assertEquals(host.listeners.size, 0);
  host.refuse();
  assertEquals(told, 0);
});

const html = () =>
  Deno.readTextFileSync(new URL("../public/index.html", import.meta.url));
const source = (name: string) =>
  Deno.readTextFileSync(new URL(`../src/${name}`, import.meta.url));

Deno.test("a refusal reaches the banner: kernel, coordinator, page, index.html", () => {
  // The coordinator's env hook posts the message the page handles, and the
  // page shows the element index.html has under that id: a renamed message
  // type or element id breaks this, not just the browser.
  const host = fakeHost();
  const posted: { type: string }[] = [];
  watchGuestMemoryRefusals(host, () => posted.push(memoryRefusedMessage()));
  const page = html();
  const elements = new Map<string, { hidden: boolean }>();
  for (const id of [MEMORY_REFUSED_BANNER_ID, MEMORY_REFUSED_RELOAD_ID]) {
    const tag = page.match(new RegExp(`<[a-z]+[^>]*\\sid="${id}"[^>]*>`));
    assert(tag !== null, `index.html has no #${id}`);
    elements.set(id, { hidden: /\shidden[\s>]/.test(tag[0]) });
  }
  const byId = (id: string) => {
    const element = elements.get(id);
    if (element === undefined) throw new Error(`missing #${id}`);
    return element;
  };
  assertEquals(byId(MEMORY_REFUSED_BANNER_ID).hidden, true, "hidden at load");
  host.refuse();
  assertEquals(posted.length, 1);
  showMemoryRefused({ type: "out" }, byId);
  assertEquals(byId(MEMORY_REFUSED_BANNER_ID).hidden, true);
  for (const message of posted) showMemoryRefused(message, byId);
  assertEquals(byId(MEMORY_REFUSED_BANNER_ID).hidden, false);
  // The next session the page boots starts without it.
  hideMemoryRefused(byId);
  assertEquals(byId(MEMORY_REFUSED_BANNER_ID).hidden, true);

  // And the real modules use exactly these pieces.
  assert(
    /memoryRefused: \(\) => post\(memoryRefusedMessage\(\)\)/.test(
      source("coordinator_worker.ts"),
    ),
    "the coordinator posts memoryRefusedMessage() from env.memoryRefused",
  );
  const pageTs = source("page.ts");
  assert(/showMemoryRefused\(msg, byId\)/.test(pageTs), "page shows it");
  assert(/hideMemoryRefused\(byId\)/.test(pageTs), "boot hides it");
  assert(/byId\(MEMORY_REFUSED_RELOAD_ID\)/.test(pageTs), "Reload is bound");
  assert(
    /stopWatchingRefusals\(\)/.test(source("boot.ts")),
    "the session's stop() stops watching",
  );
});

/** Just enough of `document` for `mountMemoryRefusedBanner`. */
function fakeDocument() {
  type Node = {
    tag: string;
    id: string;
    hidden: boolean;
    type: string;
    textContent: string;
    dataset: Record<string, string>;
    attributes: Map<string, string>;
    style: { cssText: string };
    children: Node[];
    clicks: (() => void)[];
    setAttribute(name: string, value: string): void;
    append(child: Node): void;
    addEventListener(event: string, listener: () => void): void;
  };
  const all: Node[] = [];
  const body: Node[] = [];
  const doc = {
    getElementById: (id: string) => all.find((n) => n.id === id) ?? null,
    createElement(tag: string): Node {
      const node: Node = {
        tag,
        id: "",
        hidden: false,
        type: "",
        textContent: "",
        dataset: {},
        attributes: new Map(),
        style: { cssText: "" },
        children: [],
        clicks: [],
        setAttribute(name, value) {
          node.attributes.set(name, value);
        },
        append(child) {
          node.children.push(child);
          all.push(child);
        },
        addEventListener(event, listener) {
          if (event === "click") node.clicks.push(listener);
        },
      };
      return node;
    },
    body: {
      prepend(node: Node) {
        body.unshift(node);
        all.push(node);
      },
    },
  };
  return { doc: doc as unknown as Document, body };
}

Deno.test("a page without the static banner builds the same one, once", () => {
  const { doc, body } = fakeDocument();
  let reloads = 0;
  const banner = mountMemoryRefusedBanner(doc, () => reloads++);
  assertEquals(body.length, 1);
  assertEquals(banner.id, MEMORY_REFUSED_BANNER_ID);
  assertEquals(body[0].attributes.get("role"), "alert");
  assertEquals(body[0].textContent.trim(), MEMORY_REFUSED_TEXT);
  // Above JupyterLite's shell, which covers the whole body.
  assert(/position: fixed/.test(body[0].style.cssText));
  const [reload] = body[0].children;
  assertEquals(reload.id, MEMORY_REFUSED_RELOAD_ID);
  assertEquals(reload.textContent, "Reload");
  for (const click of reload.clicks) click();
  assertEquals(reloads, 1);
  // A second refusal finds it rather than stacking another.
  assertEquals(mountMemoryRefusedBanner(doc, () => reloads++), banner);
  assertEquals(body.length, 1);
});

Deno.test("the snapshot demo and both notebook kernels show the banner (#213)", () => {
  // Each worker that boots or restores a kernel watches that kernel and
  // posts the message; each page side that receives it mounts the banner.
  const watch =
    /watchGuestMemoryRefusals\((mk|restored\.host), \(\) => post\(memoryRefusedMessage\(\)\)\)/g;
  for (const worker of ["snapshot_worker.ts", "notebook_kernel_worker.ts"]) {
    const text = source(worker);
    const watched = [...text.matchAll(watch)].map((m) => m[1]).sort();
    assertEquals(
      watched,
      ["mk", "restored.host"],
      `${worker} watches its booted and its restored kernel`,
    );
    assert(
      /loadPlaygroundKernel\(kernel\);\n(.*\n){0,3}.*watchGuestMemoryRefusals\(mk,/
        .test(text),
      `${worker} watches the booted kernel before its guest starts`,
    );
  }
  assertEquals(MEMORY_REFUSED_MESSAGE_TYPE, "memory-refused");
  for (const page of ["snapshot_page.ts", "snapshot_bridge.ts"]) {
    assert(
      /case "memory-refused":\s*mountMemoryRefusedBanner\(document\);/.test(
        source(page),
      ),
      `${page} mounts the banner`,
    );
  }
  // The ipykernel notebook runs on the main page's coordinator, which
  // already posts the message (checked above); its bridge must show it.
  assert(
    /msg\.type === MEMORY_REFUSED_MESSAGE_TYPE\) \{[^}]*mountMemoryRefusedBanner\(document\)/
      .test(source("lite_bridge.ts")),
    "lite_bridge.ts mounts the banner",
  );
});
