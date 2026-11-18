import { assert, assertEquals, assertNotStrictEquals } from "@std/assert";
import {
  type KeyStore,
  saveKeys,
  signBytes,
  verifyBytes,
} from "../src/save_key.ts";

/** A store that keeps what it is given, as IndexedDB would. */
function memoryStore(): KeyStore & { puts: number } {
  let kept: CryptoKey | undefined;
  const store = {
    puts: 0,
    get: () => Promise.resolve(kept),
    putIfAbsent(key: CryptoKey) {
      store.puts++;
      kept ??= key;
      return Promise.resolve(kept);
    },
  };
  return store;
}

const bytes = (text: string) => new TextEncoder().encode(text);

Deno.test("the save key is made once, kept, and non-extractable", async () => {
  const store = memoryStore();
  const first = await saveKeys(() => store).key();
  assertEquals(first.scope, "persistent");
  assertEquals(first.key.extractable, false);
  assertEquals(first.key.usages.sort(), ["sign", "verify"]);
  // Another worker of the same origin (a reload) finds the same key.
  const again = await saveKeys(() => store).key();
  assert(again.key === first.key);
  assertEquals(store.puts, 1);
});

Deno.test("refused storage gives a key for this worker alone, said so", async () => {
  const keys = saveKeys(() => {
    throw new DOMException("blocked", "SecurityError");
  });
  const first = await keys.key();
  assertEquals(first.scope, "session");
  // The same key for the life of the worker: a Load in this tab works.
  assert((await keys.key()).key === first.key);
  // A store that refuses when used, not when made, too.
  const rejecting = saveKeys(() => ({
    get: () => Promise.reject(new Error("QuotaExceededError")),
    putIfAbsent: () => Promise.reject(new Error("unused")),
  }));
  assertEquals((await rejecting.key()).scope, "session");
});

Deno.test("a signature verifies only for its key and its bytes", async () => {
  const mine = (await saveKeys(() => memoryStore()).key()).key;
  const theirs = (await saveKeys(() => memoryStore()).key()).key;
  assertNotStrictEquals(mine, theirs);
  const tag = await signBytes(mine, bytes("manifest"));
  assert(/^[0-9a-f]{64}$/.test(tag));
  assert(await verifyBytes(mine, bytes("manifest"), tag));
  assert(!await verifyBytes(theirs, bytes("manifest"), tag));
  assert(!await verifyBytes(mine, bytes("manifesu"), tag));
  assert(!await verifyBytes(mine, bytes("manifest"), "00".repeat(32)));
  assert(!await verifyBytes(mine, bytes("manifest"), "not hex"));
});

Deno.test("a store that fails once is tried again: a transient error is not a session for the worker's life", async () => {
  const store = memoryStore();
  let fail = true;
  const keys = saveKeys(() => {
    if (fail) {
      fail = false;
      throw new Error("connection lost");
    }
    return store;
  });
  assertEquals((await keys.key()).scope, "session");
  const next = await keys.key();
  assertEquals(next.scope, "persistent");
  assert(next.key === await store.get());
});

Deno.test("a store that never answers is given up on in time, for this call", async () => {
  const keys = saveKeys(() => ({
    get: () => new Promise<CryptoKey | undefined>(() => {}),
    putIfAbsent: () => new Promise<CryptoKey>(() => {}),
  }), { timeoutMs: 20 });
  const started = Date.now();
  const got = await keys.key();
  assertEquals(got.scope, "session");
  assert(Date.now() - started < 1000);
  // While it keeps failing, the session key stays the same one.
  assert((await keys.key()).key === got.key);
});

Deno.test("a file signed while the store was down still loads once it is back: Load checks every key this worker holds", async () => {
  const store = memoryStore();
  let down = true;
  const keys = saveKeys(() => {
    if (down) throw new Error("connection lost");
    return store;
  });
  const during = await keys.key();
  assertEquals(during.scope, "session");
  const tag = await signBytes(during.key, bytes("saved while down"));
  down = false;
  assertEquals((await keys.key()).scope, "persistent");
  const held = await keys.held();
  assertEquals(held.length, 2);
  assert(
    (await Promise.all(
      held.map((key) => verifyBytes(key, bytes("saved while down"), tag)),
    )).some(Boolean),
  );
});

Deno.test("a store that timed out is not waited for again, and is asked once at a time", async () => {
  let opens = 0;
  const keys = saveKeys(() => {
    opens++;
    return {
      get: () => new Promise<CryptoKey | undefined>(() => {}),
      putIfAbsent: () => new Promise<CryptoKey>(() => {}),
    };
  }, { timeoutMs: 50 });
  await keys.key();
  const started = Date.now();
  await Promise.all([keys.key(), keys.key()]);
  assert(Date.now() - started < 40, "the second wait is not the full bound");
  assertEquals(opens, 1);
});

Deno.test("a session key that could not be made is tried again, not kept as a failure", async () => {
  const real = crypto.subtle.generateKey.bind(crypto.subtle);
  let failNext = true;
  const subtle = crypto.subtle as { generateKey: typeof real };
  subtle.generateKey = ((...args: Parameters<typeof real>) => {
    if (failNext) {
      failNext = false;
      return Promise.reject(new Error("no entropy"));
    }
    return real(...args);
  }) as typeof real;
  try {
    const keys = saveKeys(() => {
      throw new Error("blocked");
    });
    let threw = false;
    await keys.key().catch(() => threw = true);
    assert(threw);
    assertEquals((await keys.key()).scope, "session");
  } finally {
    subtle.generateKey = real;
  }
});
