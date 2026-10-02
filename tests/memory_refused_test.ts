import { assertEquals } from "@std/assert";
import {
  MEMORY_REFUSED_MESSAGE,
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

Deno.test("the message names no engine: Chrome and Firefox refuse too", () => {
  assertEquals(
    MEMORY_REFUSED_MESSAGE,
    "The browser ran out of memory for new processes. Reload the page to continue.",
  );
});
