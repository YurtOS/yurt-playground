import { assertEquals } from "@std/assert";
import {
  memoryRefusedMessage,
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

Deno.test("the message names Safari only in Safari", () => {
  const safari =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6 Safari/605.1.15";
  const chrome =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
  const firefox =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:143.0) Gecko/20100101 Firefox/143.0";
  assertEquals(
    memoryRefusedMessage(safari),
    "Safari ran out of memory for new processes. Reload the page to continue.",
  );
  for (const agent of [chrome, firefox]) {
    assertEquals(
      memoryRefusedMessage(agent),
      "The browser ran out of memory for new processes. Reload the page to continue.",
    );
  }
});
