/**
 * The playground image is ~87 MB and Cloudflare Pages refuses any file over
 * 25 MiB, so the static build ships it as fixed-size parts next to a manifest,
 * and the page reassembles them. The dev server slices its single file on the
 * fly so the page has one fetch path.
 */
export const IMAGE_PART_BYTES = 20 * 1024 * 1024;

export type ImagePartsManifest = { size: number; parts: string[] };

/** Manifest for an image of `size` bytes published as `name` parts. */
export function imagePartsManifest(
  name: string,
  size: number,
): ImagePartsManifest {
  const count = Math.max(1, Math.ceil(size / IMAGE_PART_BYTES));
  return {
    size,
    parts: Array.from({ length: count }, (_, i) => `${name}.${i}`),
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

/**
 * A `fetch` that answers a request for `name` by fetching `name.parts.json`
 * and streaming the parts in order, so callers that read a single body
 * (hash check, progress, cache) need not know the file was split.
 */
export function partsFetch(
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): typeof globalThis.fetch {
  return async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const base = typeof location === "undefined" ? undefined : location.href;
    const manifestUrl = new URL(`${url}.parts.json`, base);
    const manifestResponse = await fetchImpl(manifestUrl, init);
    if (!manifestResponse.ok) return manifestResponse;
    const manifest = await manifestResponse.json() as ImagePartsManifest;
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          for (const part of manifest.parts) {
            const response = await fetchImpl(new URL(part, manifestUrl), init);
            if (!response.ok || response.body === null) {
              throw new Error(`fetch ${part} failed: ${response.status}`);
            }
            for await (const chunk of response.body) controller.enqueue(chunk);
          }
          controller.close();
        } catch (error) {
          controller.error(error);
        }
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { "content-length": String(manifest.size) },
    });
  };
}
