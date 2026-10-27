import { assertEquals } from "@std/assert";
import { sealedUnderNewerIndex } from "../src/snapshot_store.ts";

Deno.test("a suspend is kept only while the page's index is behind the one it was sealed under", () => {
  // The page reads index 22; the suspend's set came from index 23 (a set
  // whose python-seal was published after python, say): the page is behind.
  assertEquals(sealedUnderNewerIndex({ indexVersion: 23 }, 22), true);
  // The same index, or a newer one (a set withdrawn by a yank or a
  // deletion is a newer index): the mismatch stands, and it is discarded.
  assertEquals(sealedUnderNewerIndex({ indexVersion: 23 }, 23), false);
  assertEquals(sealedUnderNewerIndex({ indexVersion: 23 }, 24), false);
  // Sealed before sets, or with no index read now: never kept.
  assertEquals(sealedUnderNewerIndex({}, 22), false);
  assertEquals(sealedUnderNewerIndex({ indexVersion: 23 }, undefined), false);
});
