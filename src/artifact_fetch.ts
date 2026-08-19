import { type ArtifactPin, sha256Hex } from "./pins.ts";

export type ArtifactProgress = {
  loaded: number;
  total?: number;
};

export type ArtifactFetchOptions = {
  url: string;
  cacheName?: string;
  cacheStorage?: CacheStorage;
  fetch?: typeof globalThis.fetch;
  onProgress?: (progress: ArtifactProgress) => void;
};

export async function fetchPinnedArtifact(
  pin: ArtifactPin,
  options: ArtifactFetchOptions,
): Promise<Uint8Array> {
  const cache = options.cacheStorage && options.cacheName
    ? await options.cacheStorage.open(options.cacheName)
    : undefined;

  if (cache !== undefined) {
    const cached = await cache.match(options.url);
    if (cached !== undefined) {
      const bytes = await readResponseBytes(cached, options.onProgress);
      if (await sha256Hex(bytes) === pin.sha256) return bytes;
      await cache.delete(options.url);
    }
  }

  const fetchImpl = options.fetch ?? globalThis.fetch;
  const response = await fetchImpl(options.url);
  if (!response.ok) {
    throw new Error(`fetch ${options.url} failed: ${response.status}`);
  }
  const bytes = await readResponseBytes(response, options.onProgress);
  const actual = await sha256Hex(bytes);
  if (actual !== pin.sha256) {
    throw new Error(
      `sha256 mismatch for ${options.url}: got ${actual}, pin ${pin.sha256}`,
    );
  }

  if (cache !== undefined) {
    await cache.put(
      options.url,
      new Response(bytes as unknown as BodyInit, {
        status: 200,
        headers: response.headers,
      }),
    );
  }
  return bytes;
}

async function readResponseBytes(
  response: Response,
  onProgress?: (progress: ArtifactProgress) => void,
): Promise<Uint8Array> {
  const totalHeader = response.headers.get("content-length");
  const total = totalHeader === null ? undefined : Number(totalHeader);
  if (response.body === null) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    onProgress?.({ loaded: bytes.byteLength, total });
    return bytes;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    chunks.push(value);
    loaded += value.byteLength;
    onProgress?.({ loaded, total });
  }
  const bytes = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  onProgress?.({ loaded, total: total ?? loaded });
  return bytes;
}
