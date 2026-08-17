import { assertEquals } from "@std/assert";
import { spinWait } from "../src/atomics_wait.ts";

Deno.test("spinWait returns not-equal when the cell already changed", () => {
  const arr = new Int32Array(new SharedArrayBuffer(4));
  arr[0] = 1;
  assertEquals(spinWait(arr, 0, 0, 50), "not-equal");
});

Deno.test("spinWait times out if the cell never changes", () => {
  const arr = new Int32Array(new SharedArrayBuffer(4));
  assertEquals(spinWait(arr, 0, 0, 5), "timed-out");
});
