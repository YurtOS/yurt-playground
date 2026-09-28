/**
 * How the agent's model weights sit in Cache Storage (#150). Safari fails a
 * single `cache.put` over 2 GiB ("Failed writing data to the file system")
 * whatever the quota, and Gemma 4 E4B is 2.77 GiB, so a model is stored as
 * parts under their own keys and read back as one Blob of them. The entry
 * at the model's own key is written last and names the part count, so a
 * download cut short leaves no entry and is fetched again. A write that
 * fails (a network error, the quota) removes the parts it wrote: they are
 * up to gigabytes, and nothing else would find them if the next download is
 * a different model.
 */

/** Well under Safari's 2 GiB, and small enough to hold in memory while it
 * is written. */
export const PART_BYTES = 64 * 1024 * 1024;

/** On the head entry: how many parts follow. Absent on a model stored whole
 * (before #150), which is read back as it is. */
const PARTS_HEADER = "x-yurt-parts";

type ModelCache = Pick<Cache, "match" | "put" | "delete">;

function partKey(key: string, index: number): string {
  return `${key}${key.includes("?") ? "&" : "?"}part=${index}`;
}

/** The stored model, or `undefined` when there is none or a part of it is
 * gone (the caller fetches it again, and its sweep drops the rest). */
export async function readModel(
  cache: ModelCache,
  key: string,
): Promise<Blob | undefined> {
  const head = await cache.match(key);
  if (head === undefined) return undefined;
  const count = head.headers.get(PARTS_HEADER);
  if (count === null) return await head.blob();
  const n = Number(count);
  if (!Number.isInteger(n) || n < 0) return undefined;
  const parts: Blob[] = [];
  for (let index = 0; index < n; index++) {
    const part = await cache.match(partKey(key, index));
    if (part === undefined) return undefined;
    parts.push(await part.blob());
  }
  // A Blob of disk-backed Blobs: nothing is read into memory here.
  return new Blob(parts);
}

/** Write `body` under `key`, in parts of about `partBytes`; the head entry
 * goes last. Returns the bytes stored. */
export async function storeModel(
  cache: ModelCache,
  key: string,
  body: ReadableStream<Uint8Array<ArrayBuffer>>,
  partBytes = PART_BYTES,
): Promise<number> {
  let pending: Uint8Array<ArrayBuffer>[] = [];
  let pendingBytes = 0;
  let parts = 0;
  let total = 0;
  const flush = async () => {
    await cache.put(partKey(key, parts), new Response(new Blob(pending)));
    parts++;
    pending = [];
    pendingBytes = 0;
  };
  try {
    for await (const chunk of body) {
      pending.push(chunk);
      pendingBytes += chunk.byteLength;
      total += chunk.byteLength;
      if (pendingBytes >= partBytes) await flush();
    }
    if (pendingBytes > 0) await flush();
  } catch (error) {
    // `parts` is the one that failed, if a put did; delete it too.
    for (let index = 0; index <= parts; index++) {
      await cache.delete(partKey(key, index)).catch(() => false);
    }
    throw error;
  }
  await cache.put(
    key,
    new Response(null, { headers: { [PARTS_HEADER]: String(parts) } }),
  );
  return total;
}
