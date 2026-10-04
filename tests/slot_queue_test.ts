import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { GUEST_HTTP_TIMEOUT_MS, GuestHttpError } from "../src/guest_http.ts";
import {
  ByteBudget,
  REQUEST_DEADLINE_MS,
  SLOT_LIMITS,
  SlotQueue,
} from "../src/slot_queue.ts";

const limits = { perSession: 2, global: 3, maxWaiting: 2, waitMs: 50 };
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

Deno.test("per-session cap queues requests in FIFO order", async () => {
  const queue = new SlotQueue(limits);
  const first = await queue.acquire("s1");
  const second = await queue.acquire("s1");
  const order: string[] = [];
  const third = queue.acquire("s1").then((release) => {
    order.push("third");
    return release;
  });
  const fourth = queue.acquire("s1").then((release) => {
    order.push("fourth");
    return release;
  });
  await tick();
  assertEquals(order, []);
  first();
  const releaseThird = await third;
  assertEquals(order, ["third"]);
  second();
  const releaseFourth = await fourth;
  assertEquals(order, ["third", "fourth"]);
  releaseThird();
  releaseFourth();
});

Deno.test("global cap is shared and a blocked session does not block another", async () => {
  const queue = new SlotQueue(limits);
  const s1a = await queue.acquire("s1");
  const s1b = await queue.acquire("s1");
  const s2a = await queue.acquire("s2");
  const s1c = queue.acquire("s1");
  let s2bGranted = false;
  const s2b = queue.acquire("s2").then((release) => {
    s2bGranted = true;
    return release;
  });
  await tick();
  assertEquals(s2bGranted, false);
  s2a();
  const releaseS2b = await s2b;
  releaseS2b();
  s1a();
  (await s1c)();
  s1b();
});

Deno.test("release is idempotent and does not overbook a session", async () => {
  const queue = new SlotQueue({ ...limits, perSession: 1 });
  const first = await queue.acquire("s");
  first();
  first();
  const second = await queue.acquire("s");
  let thirdGranted = false;
  const third = queue.acquire("s").then((release) => {
    thirdGranted = true;
    return release;
  });
  await tick();
  assertEquals(thirdGranted, false);
  second();
  (await third)();
});

Deno.test("full per-session queue and expired waits return 503", async () => {
  const queue = new SlotQueue(limits);
  const held = [await queue.acquire("s"), await queue.acquire("s")];
  const first = queue.acquire("s");
  const second = queue.acquire("s");
  const full = await assertRejects(() => queue.acquire("s"), GuestHttpError);
  assertEquals(full.status, 503);
  const expired = await assertRejects(() => first, GuestHttpError);
  assertEquals(expired.status, 503);
  await assertRejects(() => second, GuestHttpError);
  held.forEach((release) => release());
  (await queue.acquire("s"))();
});

Deno.test("abort removes a waiter and frees its queue position", async () => {
  const queue = new SlotQueue({
    ...limits,
    perSession: 1,
    maxWaiting: 1,
    waitMs: 5_000,
  });
  const held = await queue.acquire("s");
  const controller = new AbortController();
  const waiting = queue.acquire("s", controller.signal);
  controller.abort(new Error("gone"));
  await assertRejects(() => waiting, Error, "gone");
  const next = queue.acquire("s");
  held();
  (await next)();
});

Deno.test("already aborted signal rejects through the promised result", async () => {
  const queue = new SlotQueue(limits);
  const controller = new AbortController();
  controller.abort(new Error("gone"));
  const result = queue.acquire("s", controller.signal);
  await assertRejects(() => result, Error, "gone");
  (await queue.acquire("s"))();
});

Deno.test("ByteBudget rejects over limit and frees reservations", () => {
  const budget = new ByteBudget(100);
  budget.take(60);
  const error = assertThrows(
    () => budget.take(41),
    GuestHttpError,
    "buffer limit",
  );
  assertEquals(error.status, 503);
  budget.take(40);
  budget.give(60);
  budget.take(60);
  budget.give(1_000);
  budget.take(100);
});

Deno.test("ByteBudget rejects invalid reservations without losing its limit", () => {
  const budget = new ByteBudget(100);
  assertThrows(() => budget.take(-1), RangeError);
  assertThrows(() => budget.take(Number.NaN), RangeError);
  assertThrows(() => budget.give(-1), RangeError);
  budget.take(100);
  assertThrows(() => budget.take(1), GuestHttpError);
});

Deno.test("service worker deadline includes queue wait, HTTP deadline, and slack", () => {
  assertEquals(
    REQUEST_DEADLINE_MS,
    SLOT_LIMITS.waitMs + GUEST_HTTP_TIMEOUT_MS + 5_000,
  );
});
