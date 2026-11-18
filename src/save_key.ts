/**
 * The key that makes a saved sandbox this browser's own (Save / Load
 * sandbox, yurt-playground#8, yurtos-kernel#5021): Load restores only a
 * file this browser signed. A restore takes the file's kernel memory as
 * the kernel's whole state, so a file from anywhere else is refused, not
 * validated.
 *
 * The key is an HMAC-SHA-256 CryptoKey made once per origin and kept in
 * IndexedDB as the CryptoKey itself, never as bytes: it is
 * non-extractable, so nothing can read it out. It can still be used: any
 * script running on this origin can open the store and sign with it. That
 * is accepted, because such script already controls the page; what keeps
 * guest code and notebook output from running script here is the guest's
 * wasm boundary and #336 (no JS output renderer, no trusted notebooks).
 * Clearing the site's data loses the key, and with it the files saved
 * before.
 *
 * Where IndexedDB is refused (storage blocked for the site) or does not
 * answer, the key is made for this worker alone: a Save still works, and
 * says that its file loads only in this tab until it is reloaded or
 * closed.
 */

/** The IndexedDB database and store that keep the key (the page's own
 * origin; the coordinator worker opens it). */
export const SAVE_KEY_DB = "yurt-playground-save-key";
export const SAVE_KEY_STORE = "keys";
export const SAVE_KEY_ID = "hmac-sha256-v1";

/** Where the key lives: `persistent`, in IndexedDB; `session`, in this
 * worker only (storage refused). */
export type SaveKeyScope = "persistent" | "session";

export type SaveKey = { key: CryptoKey; scope: SaveKeyScope };

const ALGORITHM = { name: "HMAC", hash: "SHA-256" } as const;

/** What the key store needs of IndexedDB: the browser's, or a test's. */
export type KeyStore = {
  get(): Promise<CryptoKey | undefined>;
  /** Keep `key` unless one is already kept; the one kept. */
  putIfAbsent(key: CryptoKey): Promise<CryptoKey>;
};

/** The browser's IndexedDB as a {@link KeyStore}; throws when the site's
 * storage is refused. */
export function indexedDbKeyStore(
  factory: IDBFactory = indexedDB,
): KeyStore {
  const open = () =>
    new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open(SAVE_KEY_DB, 1);
      request.onupgradeneeded = () =>
        request.result.createObjectStore(SAVE_KEY_STORE);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("the key store is blocked"));
    });
  const run = async <T>(
    mode: IDBTransactionMode,
    work: (store: IDBObjectStore) => IDBRequest<T> | undefined,
    then?: (store: IDBObjectStore, value: T) => IDBRequest<unknown> | void,
  ): Promise<T> => {
    const db = await open();
    try {
      return await new Promise<T>((resolve, reject) => {
        const tx = db.transaction(SAVE_KEY_STORE, mode);
        const store = tx.objectStore(SAVE_KEY_STORE);
        let value: T;
        const request = work(store);
        if (request !== undefined) {
          request.onsuccess = () => {
            value = request.result;
            then?.(store, value);
          };
        }
        tx.oncomplete = () => resolve(value);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error ?? new Error("aborted"));
      });
    } finally {
      db.close();
    }
  };
  return {
    get: () =>
      run<CryptoKey | undefined>(
        "readonly",
        (store) => store.get(SAVE_KEY_ID),
      ),
    // One transaction: two tabs making a key at once keep the first.
    async putIfAbsent(key) {
      let kept = key;
      await run<CryptoKey | undefined>(
        "readwrite",
        (store) => store.get(SAVE_KEY_ID),
        (store, existing) => {
          if (existing !== undefined) {
            kept = existing;
            return;
          }
          store.put(key, SAVE_KEY_ID);
        },
      );
      return kept;
    },
  };
}

/** How long a key store may take to answer before this call makes do
 * with a session key: an IndexedDB open that never settles must not hold
 * a Save. */
export const KEY_STORE_TIMEOUT_MS = 5_000;

/** The origin's key, made on first use; the same one for every later
 * call once the store has given it. A store that fails or does not
 * answer in time gives this call the worker's session key (said so by
 * its scope), and is asked again on the next call: a transient error is
 * not a blocked site for the worker's whole life. */
export function saveKeys(
  store: () => KeyStore,
  { timeoutMs = KEY_STORE_TIMEOUT_MS } = {},
) {
  /** The store's key, once it has given one. */
  let persistent: CryptoKey | undefined;
  /** The key for while the store fails: one per worker. */
  let session: Promise<CryptoKey> | undefined;
  const make = () =>
    crypto.subtle.generateKey(ALGORITHM, false, [
      "sign",
      "verify",
    ]) as Promise<CryptoKey>;
  const fromStore = async (): Promise<CryptoKey> => {
    const keys = store();
    return await keys.get() ?? await keys.putIfAbsent(await make());
  };
  return {
    /** The key, made (and kept) if there is none yet: what Save signs
     * with, and Load checks with. */
    async key(): Promise<SaveKey> {
      if (persistent !== undefined) {
        return { key: persistent, scope: "persistent" };
      }
      let timer: number | undefined;
      try {
        persistent = await Promise.race([
          fromStore(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("the key store did not answer")),
              timeoutMs,
            );
          }),
        ]);
        return { key: persistent, scope: "persistent" };
      } catch {
        session ??= make();
        return { key: await session, scope: "session" };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** `bytes` signed with `key`, as hex. */
export async function signBytes(
  key: CryptoKey,
  bytes: Uint8Array<ArrayBuffer>,
): Promise<string> {
  const tag = new Uint8Array(await crypto.subtle.sign("HMAC", key, bytes));
  return [...tag].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Whether `tag` (hex) is `key`'s signature of `bytes`; constant time in
 * the platform's verify. */
export async function verifyBytes(
  key: CryptoKey,
  bytes: Uint8Array<ArrayBuffer>,
  tag: string,
): Promise<boolean> {
  if (!/^[0-9a-f]{64}$/.test(tag)) return false;
  const raw = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    raw[i] = parseInt(tag.slice(2 * i, 2 * i + 2), 16);
  }
  return await crypto.subtle.verify("HMAC", key, raw, bytes);
}
