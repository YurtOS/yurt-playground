import { assertEquals } from "@std/assert";
import { DeferredWork } from "../src/boot.ts";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

Deno.test("deferred work waits for its delay, and hurry starts it at once", async () => {
  const work = new DeferredWork();
  const ran: string[] = [];
  let finish = () => {};
  work.defer(Promise.resolve(), () => {
    ran.push("sweep");
    return new Promise<void>((resolve) => finish = resolve);
  }, 60_000);
  await tick();
  assertEquals(ran, [], "still waiting for its delay");
  assertEquals(work.idle, false);
  work.hurry();
  assertEquals(ran, ["sweep"], "started without its delay");
  assertEquals(work.idle, false, "running");
  finish();
  await tick();
  assertEquals(work.idle, true);
});

Deno.test("work whose start is still pending keeps deferred work busy, and starts at once after hurry", async () => {
  const work = new DeferredWork();
  const ran: string[] = [];
  let exit = () => {};
  // An exec that has not exited yet: its sweep is not even waiting.
  work.defer(
    new Promise<void>((resolve) => exit = resolve),
    () => {
      ran.push("sweep");
      return Promise.resolve();
    },
    60_000,
  );
  work.hurry();
  await tick();
  assertEquals(ran, []);
  assertEquals(work.idle, false, "the exec's sweep is still to come");
  exit();
  await tick();
  assertEquals(ran, ["sweep"], "no delay once hurried");
  assertEquals(work.idle, true);
});

Deno.test("a failed exit or a failed run still ends the deferred work", async () => {
  const work = new DeferredWork();
  work.defer(Promise.reject(new Error("exit")), () => Promise.resolve(), 10);
  work.defer(Promise.resolve(), () => Promise.reject(new Error("rm")), 10);
  work.hurry();
  await tick();
  await tick();
  assertEquals(work.idle, true);
});
