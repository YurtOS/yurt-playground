import { assert, assertEquals } from "@std/assert";
import {
  hideMemoryRefused,
  MEMORY_REFUSED_BANNER_ID,
  MEMORY_REFUSED_RELOAD_ID,
  memoryRefusedMessage,
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
  assertEquals(
    text,
    "The browser ran out of memory for new processes. Reload the page to continue.",
  );
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
