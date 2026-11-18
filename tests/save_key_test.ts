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
