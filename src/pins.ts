export type ArtifactPin = {
  repo: string;
  rev: string;
  build: string;
  path: string;
  sha256: string;
};

export type Pins = {
  kernelWasm: ArtifactPin;
  image: ArtifactPin;
};

export type ArtifactSource = "artifacts" | "siblings" | "urls";

export type ResolvedArtifacts = {
  kernelWasmPath: string;
  imagePath: string;
  source: ArtifactSource;
};

export type ResolveArtifactsOptions = {
  artifactsDir: string;
  pins: Pins;
  kernelRoot?: string;
  portsRoot?: string;
  kernelUrl?: string;
  imageUrl?: string;
  fetchBytes?: (url: string) => Promise<Uint8Array>;
};

export class PinResolutionError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode: number) {
    super(message);
    this.name = "PinResolutionError";
    this.exitCode = exitCode;
  }
}

const KERNEL_BLOB = "yurt_kernel.wasm";
const IMAGE_BLOB = "playground.yurtimg";

const MISSING_SOURCE_HELP = [
  "no matching playground artifacts.",
  "provide one of:",
  "  1. artifacts/yurt_kernel.wasm and artifacts/playground.yurtimg",
  "  2. YURT_KERNEL_ROOT and YURT_PORTS_ROOT pointing at sibling checkouts",
  "  3. PLAYGROUND_KERNEL_WASM_URL and PLAYGROUND_IMAGE_URL",
].join("\n");

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function parsePins(raw: unknown): Pins {
  if (raw === null || typeof raw !== "object") {
    throw new PinResolutionError("pins.json must be an object", 1);
  }
  const value = raw as { kernelWasm?: unknown; image?: unknown };
  return {
    kernelWasm: parsePin(value.kernelWasm, "kernelWasm"),
    image: parsePin(value.image, "image"),
  };
}

export async function loadPins(path: string): Promise<Pins> {
  return parsePins(JSON.parse(await Deno.readTextFile(path)));
}

export async function resolveArtifacts(
  opts: ResolveArtifactsOptions,
): Promise<ResolvedArtifacts> {
  const kernelPath = joinPath(opts.artifactsDir, KERNEL_BLOB);
  const imagePath = joinPath(opts.artifactsDir, IMAGE_BLOB);
  const existing = await readPair(kernelPath, imagePath);
  if (existing !== undefined) {
    await assertHashes(
      existing.kernel,
      existing.image,
      opts.pins,
      "artifacts/",
    );
    return { kernelWasmPath: kernelPath, imagePath, source: "artifacts" };
  }

  if (opts.kernelRoot && opts.portsRoot) {
    const kernelSrc = joinPath(
      opts.kernelRoot,
      opts.pins.kernelWasm.path,
    );
    const imageSrc = joinPath(opts.portsRoot, opts.pins.image.path);
    const pair = await readPair(kernelSrc, imageSrc);
    if (pair === undefined) {
      throw new PinResolutionError(
        `sibling artifacts missing:\n  ${kernelSrc}\n  ${imageSrc}`,
        1,
      );
    }
    await assertHashes(pair.kernel, pair.image, opts.pins, "sibling checkouts");
    await writePair(opts.artifactsDir, pair.kernel, pair.image);
    return { kernelWasmPath: kernelPath, imagePath, source: "siblings" };
  }

  if (opts.kernelUrl && opts.imageUrl) {
    const fetchBytes = opts.fetchBytes ?? defaultFetchBytes;
    const pair = {
      kernel: await fetchBytes(opts.kernelUrl),
      image: await fetchBytes(opts.imageUrl),
    };
    await assertHashes(pair.kernel, pair.image, opts.pins, "pin URLs");
    await writePair(opts.artifactsDir, pair.kernel, pair.image);
    return { kernelWasmPath: kernelPath, imagePath, source: "urls" };
  }

  throw new PinResolutionError(MISSING_SOURCE_HELP, 2);
}

function parsePin(raw: unknown, label: string): ArtifactPin {
  if (raw === null || typeof raw !== "object") {
    throw new PinResolutionError(`${label} pin must be an object`, 1);
  }
  const value = raw as Record<string, unknown>;
  for (const key of ["repo", "rev", "build", "path", "sha256"] as const) {
    if (typeof value[key] !== "string" || value[key].length === 0) {
      throw new PinResolutionError(`${label}.${key} must be a string`, 1);
    }
  }
  return {
    repo: value.repo as string,
    rev: value.rev as string,
    build: value.build as string,
    path: value.path as string,
    sha256: (value.sha256 as string).toLowerCase(),
  };
}

async function readPair(
  kernelPath: string,
  imagePath: string,
): Promise<{ kernel: Uint8Array; image: Uint8Array } | undefined> {
  try {
    const kernel = await Deno.readFile(kernelPath);
    const image = await Deno.readFile(imagePath);
    return { kernel, image };
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw error;
  }
}

async function writePair(
  artifactsDir: string,
  kernel: Uint8Array,
  image: Uint8Array,
): Promise<void> {
  await Deno.mkdir(artifactsDir, { recursive: true });
  await Deno.writeFile(joinPath(artifactsDir, KERNEL_BLOB), kernel);
  await Deno.writeFile(joinPath(artifactsDir, IMAGE_BLOB), image);
}

async function assertHashes(
  kernel: Uint8Array,
  image: Uint8Array,
  pins: Pins,
  source: string,
): Promise<void> {
  const kernelSha = await sha256Hex(kernel);
  const imageSha = await sha256Hex(image);
  const problems: string[] = [];
  if (kernelSha !== pins.kernelWasm.sha256) {
    problems.push(
      `kernel wasm sha256 mismatch from ${source}: got ${kernelSha}, pin ${pins.kernelWasm.sha256}`,
    );
  }
  if (imageSha !== pins.image.sha256) {
    problems.push(
      `image sha256 mismatch from ${source}: got ${imageSha}, pin ${pins.image.sha256}`,
    );
  }
  if (problems.length > 0) {
    throw new PinResolutionError(problems.join("\n"), 1);
  }
}

async function defaultFetchBytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new PinResolutionError(
      `fetch ${url} failed: ${response.status}`,
      1,
    );
  }
  return new Uint8Array(await response.arrayBuffer());
}

function joinPath(root: string, ...parts: string[]): string {
  const trimmed = [root, ...parts]
    .flatMap((part) => part.split("/"))
    .filter((part) => part.length > 0);
  const leading = root.startsWith("/") ? "/" : "";
  return `${leading}${trimmed.join("/")}`;
}
