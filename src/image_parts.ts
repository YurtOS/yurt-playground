/**
 * The playground image is ~87 MB and Cloudflare Pages refuses any file over
 * 25 MiB, so the static build ships it as fixed-size parts next to a manifest,
 * and the page reassembles them. The dev server slices its single file on the
 * fly so the page has one fetch path.
 */
export const IMAGE_PART_BYTES = 20 * 1024 * 1024;

/** The notebook kernel's sealable CPython (51 MB), published in parts too;
 * built by scripts/build-python-seal.sh into public/. */
export const PYTHON_SEAL_NAME = "demo/python3-seal.wasm";

export type ImagePartsManifest = { size: number; parts: string[] };

/** Manifest for an image of `size` bytes published as `name` parts. The
 * parts are named relative to the manifest, which sits beside them, so a
 * `name` with a directory lists bare `<base>.<i>` entries. */
export function imagePartsManifest(
  name: string,
  size: number,
): ImagePartsManifest {
  const count = Math.max(1, Math.ceil(size / IMAGE_PART_BYTES));
  const base = name.slice(name.lastIndexOf("/") + 1);
  return {
    size,
    parts: Array.from({ length: count }, (_, i) => `${base}.${i}`),
  };
}

/** Byte range `[start, end)` of part `index` in an image of `size` bytes. */
export function imagePartRange(
  index: number,
  size: number,
): [number, number] | undefined {
  const start = index * IMAGE_PART_BYTES;
  if (!Number.isInteger(index) || index < 0 || start >= size) {
    return undefined;
  }
  return [start, Math.min(start + IMAGE_PART_BYTES, size)];
}

/** Match `<name>.<index>` for a part request; `undefined` for anything else. */
export function imagePartIndex(path: string, name: string): number | undefined {
  const match = new RegExp(`^${name.replaceAll(".", "\\.")}\\.(\\d+)$`).exec(
    path,
  );
  return match === null ? undefined : Number(match[1]);
}

/** Checks a caller makes as the parts arrive; a throw refuses the file. */
export type PartChecks = {
  /** The manifest, before any part is fetched. */
  manifest?(manifest: ImagePartsManifest): void;
  /** Each whole part, in order, before it is handed on (so a part with a
   * check is held whole, one at a time). */
  part?(index: number, name: string, bytes: Uint8Array): Promise<void>;
};

/**
 * A `fetch` that answers a request for `name` by fetching `name.parts.json`
 * and streaming the parts in order, so callers that read a single body
 * (hash check, progress, cache) need not know the file was split. A part
 * is fetched when the reader asks for more, so at most one is in flight.
 */
export function partsFetch(
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  checks: PartChecks = {},
): typeof globalThis.fetch {
  return async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const base = typeof location === "undefined" ? undefined : location.href;
    const manifestUrl = new URL(`${url}.parts.json`, base);
    const manifestResponse = await fetchImpl(manifestUrl, init);
    if (!manifestResponse.ok) return manifestResponse;
    const manifest = await manifestResponse.json() as ImagePartsManifest;
    checks.manifest?.(manifest);
    // A reader that gives up (a cancelled body) stops the part in flight.
    const giveUp = new AbortController();
    const callerSignal = (init as { signal?: AbortSignal | null } | undefined)
      ?.signal;
    const signal = callerSignal == null
      ? giveUp.signal
      : AbortSignal.any([callerSignal, giveUp.signal]);
    let index = 0;
    // A reader, not `for await`: WebKit ships ReadableStream without
    // Symbol.asyncIterator, so iterating a body there throws.
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        for (;;) {
          if (reader !== undefined) {
            const { done, value } = await reader.read();
            if (!done) {
              controller.enqueue(value);
              return;
            }
            reader = undefined;
          }
          if (index === manifest.parts.length) {
            controller.close();
            return;
          }
          const part = manifest.parts[index];
          const at = index++;
          const response = await fetchImpl(
            new URL(part, manifestUrl),
            { ...init, signal } as RequestInit,
          );
          if (!response.ok || response.body === null) {
            throw new Error(`fetch ${part} failed: ${response.status}`);
          }
          if (checks.part === undefined) {
            reader = response.body.getReader();
            continue;
          }
          const bytes = new Uint8Array(await response.arrayBuffer());
          await checks.part(at, part, bytes);
          controller.enqueue(bytes);
          return;
        }
      },
      async cancel(reason) {
        giveUp.abort(reason);
        await reader?.cancel(reason).catch(() => {});
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { "content-length": String(manifest.size) },
    });
  };
}
