export type ArtifactPin = {
  repo: string;
  rev: string;
  build: string;
  path: string;
  sha256: string;
};

export type Pins = {
  kernelWasm: ArtifactPin;
  /** The full image: the desktop app, the CLI, and (on a site with no
   * slim pin) the suspend/resume kernel's standard library. */
  image: ArtifactPin;
  /** The slim image the browser boots: no Node, and no Python set. Absent,
   * the browser boots `image`, as before. Its pages install the Python set
   * from the live signed repository (src/python_install.ts): packages are
   * not pinned here. `python` is the python package the image itself
   * ships, from its pkg installed list (scripts/release-playground.sh);
   * absent, it ships none. pkg never replaces it, so the set installed
   * beside it is the one at its build. */
  browserImage?: ArtifactPin & { python?: { version: string; build: string } };
  /** The train's sealable CPython (the notebook kernel's interpreter),
   * built with the Python set it belongs to: what names that set here. */
  pythonSeal?: { sha256: string };
  /** The sealed sandbox `?snapshot=1` restores (src/sandbox_snapshot.ts),
   * captured locally by scripts/release-snapshot.ts and published as a
   * yurt-playground release; absent, `?snapshot=1` boots as without it.
   * Kept as written: only `?snapshot=1`, the static build and the release
   * script read it, through parseSnapshotPin, so an entry of another shape
   * never breaks a default boot or a deploy. */
  snapshot?: unknown;
  /** The tablet's, the phone's and the desktop's Go snapshots
   * (src/sandbox_snapshot.ts SNAPSHOT_KINDS), kept as written like
   * `snapshot`. */
  tabletSnapshot?: unknown;
  phoneSnapshot?: unknown;
  goSnapshot?: unknown;
};

/** What a sandbox snapshot was built from: a restore needs the same of
 * all of it. The kernel (its wasm, and the rev its JS host is bundled
 * from) and the seal format must match the memory layout; the image, the
 * Python set and the page's boot setup are what the sandbox's files and
 * login came from. */
export type SnapshotIdentity = {
  /** The kernel build the image was sealed under. */
  kernelSha256: string;
  /** The yurtos-kernel rev (`kernelWasm.rev`): the page bundles its JS
   * host from that rev, which can change while the wasm does not. */
  kernelRev: string;
  /** The host's seal image version (`SandboxSealImage.version`). */
  sealVersion: number;
  /** The page's own boot setup (`BOOT_SETUP` in src/sandbox_snapshot.ts):
   * what it stages beside the image and how it sets up the login. */
  bootSetup: number;
  /** The image the sandbox booted (the slim one, when the pins name it). */
  imageSha256: string;
  /** The train's Python set, by its sealable CPython's hash (`pythonSeal`);
   * null on a site that pins none. */
  pythonSealSha256: string | null;
};

/** What a snapshot records it was built from: its identity, and the
 * Python set the capture installed from the live repository (its layer
 * key, src/python_layer.ts), which a restore compares with the live index
 * as a stored layer is. */
export type BuiltFrom = SnapshotIdentity & {
  /** null on a site that installs no Python (the full image has it). */
  pythonSet: string | null;
};

export type SnapshotPin = {
  releaseRepo: string;
  release: string;
  /** The file's header format (src/sandbox_snapshot.ts): a page restores
   * only its own. */
  format: number;
  /** The whole gzipped file. */
  sha256: string;
  size: number;
  /** Each part's sha256, in order: the file in IMAGE_PART_BYTES slices
   * (src/image_parts.ts), as the release and the site publish it. The
   * page checks each part as it arrives -- a whole-file hash would hold
   * all 125 MB at once, which a Safari tab does not survive. */
  parts: string[];
  builtFrom: BuiltFrom;
  /** The kernel memory a restore allocates (the header's memoryBytes). */
  memoryBytes?: number;
  /** What it holds (src/sandbox_snapshot.ts SnapshotContents). */
  contents?: {
    packages: { name: string; version: string; build: string }[];
    remark: string;
  };
  /** The renderer's peak memory while restoring it, in MiB, as
   * scripts/measure-boot.ts measured it in the device's emulation. */
  restorePeakMiB?: number;
  /** Format 4 only: the YurtFS root store the snapshot carries beside the
   * kernel memory (src/root_store.ts), as its header records it. */
  store?: StorePin;
};

/** A YurtFS store's identity (yurtos-kernel#4089, the kernel's
 * `Identity`): its lineage UUID, its last batch's sequence and the
 * history hash `H` up to it. Two stores that diverged never share it, so
 * a checkpoint binds it and a restore refuses any other. */
export type StoreIdentity = {
  /** 16 bytes, hex. */
  lineage: string;
  /** A u64 in decimal: exact, where a JSON number is not past 2^53. */
  sequence: string;
  /** SHA-256, hex. */
  hash: string;
};

/** The store files a checkpoint exports, in the kernel barrier's order:
 * `data`, the active journal (`journal-a` or `journal-b`), `meta` last,
 * so an interrupted copy never holds a valid `meta`. `lock`, the empty
 * journal and `lower.tar` are not exported: the copy is completed and
 * its lower materialized where it is restored. */
export type StoreFileName = "data" | "journal-a" | "journal-b" | "meta";

/** `lower.tar` as the store's `meta` records it: the pinned image
 * (`builtFrom.imageSha256`) inflated, so a snapshot never ships it. */
export type StoreLower = { bytes: number; sha256: string };

export type StorePin = {
  identity: StoreIdentity;
  /** Each exported file, in export order, as it lies in the snapshot
   * file between the header and the kernel memory. */
  files: { name: StoreFileName; bytes: number; sha256: string }[];
  lower: StoreLower;
};

/** Why `names` is not a store export's order (data, one journal, meta),
 * or undefined. */
export function storeExportOrderProblem(
  names: readonly string[],
): string | undefined {
  const ok = names.length === 3 && names[0] === "data" &&
    (names[1] === "journal-a" || names[1] === "journal-b") &&
    names[2] === "meta";
  return ok
    ? undefined
    : `store files are ${
      JSON.stringify(names)
    }, not data, the active journal, then meta`;
}

/** A `store` entry (a pin's, or a snapshot header's), checked; `fail`
 * is called with what is wrong. */
export function parseStorePin(
  raw: unknown,
  fail: (what: string) => never,
): StorePin {
  const isHex = (value: unknown, bytes: number): value is string =>
    typeof value === "string" &&
    new RegExp(`^[0-9a-f]{${bytes * 2}}$`).test(value);
  const size = (value: unknown, min: number): value is number =>
    Number.isInteger(value) && (value as number) >= min;
  const value = (raw ?? {}) as Record<string, unknown>;
  const identity = (value.identity ?? {}) as Record<string, unknown>;
  if (
    !isHex(identity.lineage, 16) || !isHex(identity.hash, 32) ||
    typeof identity.sequence !== "string" ||
    !/^(0|[1-9][0-9]*)$/.test(identity.sequence)
  ) {
    fail(
      "store.identity must be {lineage: 16 bytes hex, sequence: decimal, hash: sha256}",
    );
  }
  const files = value.files;
  if (
    !Array.isArray(files) ||
    !files.every((file) =>
      file !== null && typeof file === "object" && size(file.bytes, 0) &&
      isHex(file.sha256, 32)
    )
  ) fail("store.files must list {name, bytes, sha256}");
  const order = storeExportOrderProblem(
    (files as { name: unknown }[]).map((file) => String(file.name)),
  );
  if (order !== undefined) fail(order);
  const lower = (value.lower ?? {}) as Record<string, unknown>;
  if (!size(lower.bytes, 1) || !isHex(lower.sha256, 32)) {
    fail("store.lower must be {bytes, sha256}");
  }
  return {
    identity: {
      lineage: identity.lineage as string,
      sequence: identity.sequence as string,
      hash: identity.hash as string,
    },
    files: (files as StorePin["files"]).map(({ name, bytes, sha256 }) => ({
      name,
      bytes,
      sha256,
    })),
    lower: { bytes: lower.bytes as number, sha256: lower.sha256 as string },
  };
}

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
  const value = raw as {
    kernelWasm?: unknown;
    image?: unknown;
    browserImage?: unknown;
    pythonSeal?: { sha256?: unknown } | null;
    snapshot?: unknown;
    tabletSnapshot?: unknown;
    phoneSnapshot?: unknown;
    goSnapshot?: unknown;
  };
  const pins: Pins = {
    kernelWasm: parsePin(value.kernelWasm, "kernelWasm"),
    image: parsePin(value.image, "image"),
  };
  if (value.browserImage !== undefined) {
    pins.browserImage = parsePin(value.browserImage, "browserImage");
    const python = (value.browserImage as { python?: unknown }).python;
    if (python !== undefined) {
      const { version, build } = (python ?? {}) as Record<string, unknown>;
      if (
        typeof version !== "string" || version === "" ||
        typeof build !== "string" || !/^yurt_\d+$/.test(build)
      ) {
        throw new PinResolutionError(
          "browserImage.python must be {version, build: yurt_N}",
          1,
        );
      }
      pins.browserImage.python = { version, build };
    }
  }
  // Read only for a snapshot's identity: an entry of another shape is
  // left out (the identity then names none, and no snapshot matches it)
  // rather than failing the default boot or a deploy.
  const sealSha256 = value.pythonSeal?.sha256;
  if (typeof sealSha256 === "string" && sealSha256 !== "") {
    pins.pythonSeal = { sha256: sealSha256.toLowerCase() };
  }
  if (value.snapshot !== undefined) pins.snapshot = value.snapshot;
  if (value.tabletSnapshot !== undefined) {
    pins.tabletSnapshot = value.tabletSnapshot;
  }
  if (value.phoneSnapshot !== undefined) {
    pins.phoneSnapshot = value.phoneSnapshot;
  }
  if (value.goSnapshot !== undefined) pins.goSnapshot = value.goSnapshot;
  return pins;
}

/** A pins.json `snapshot` entry, checked; throws on any other shape. */
export function parseSnapshotPin(raw: unknown): SnapshotPin {
  const fail = (what: string): never => {
    throw new PinResolutionError(`snapshot.${what}`, 1);
  };
  const isHex = (value: unknown): value is string =>
    typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
  const value = (raw ?? {}) as Record<string, unknown>;
  for (const key of ["releaseRepo", "release"] as const) {
    if (typeof value[key] !== "string" || value[key] === "") {
      fail(`${key} must be a string`);
    }
  }
  if (!Number.isInteger(value.format)) fail("format must be an integer");
  if (!isHex(value.sha256)) fail("sha256 must be a lowercase sha256");
  if (!Number.isInteger(value.size) || (value.size as number) <= 0) {
    fail("size must be a positive integer");
  }
  if (
    !Array.isArray(value.parts) || value.parts.length === 0 ||
    !value.parts.every(isHex)
  ) fail("parts must list each part's sha256");
  const built = (value.builtFrom ?? {}) as Record<string, unknown>;
  if (!isHex(built.kernelSha256) || !isHex(built.imageSha256)) {
    fail("builtFrom must name the kernel and image sha256");
  }
  if (built.pythonSealSha256 !== null && !isHex(built.pythonSealSha256)) {
    fail("builtFrom.pythonSealSha256 must be a sha256 or null");
  }
  if (typeof built.kernelRev !== "string" || built.kernelRev === "") {
    fail("builtFrom.kernelRev must be a string");
  }
  for (const key of ["sealVersion", "bootSetup"] as const) {
    if (!Number.isInteger(built[key])) {
      fail(`builtFrom.${key} must be an integer`);
    }
  }
  if (
    built.pythonSet !== null &&
    (typeof built.pythonSet !== "string" || built.pythonSet === "")
  ) fail("builtFrom.pythonSet must be a string or null");
  if (
    value.memoryBytes !== undefined &&
    (!Number.isInteger(value.memoryBytes) || (value.memoryBytes as number) <= 0)
  ) fail("memoryBytes must be a positive integer");
  if (
    value.restorePeakMiB !== undefined &&
    (!Number.isInteger(value.restorePeakMiB) ||
      (value.restorePeakMiB as number) <= 0)
  ) fail("restorePeakMiB must be a positive integer");
  const contents = value.contents as
    | { packages?: unknown; remark?: unknown }
    | undefined;
  if (
    contents !== undefined &&
    (typeof contents?.remark !== "string" ||
      !Array.isArray(contents.packages) ||
      !contents.packages.every((p) =>
        p !== null && typeof p === "object" &&
        ["name", "version", "build"].every((k) =>
          typeof (p as Record<string, unknown>)[k] === "string"
        )
      ))
  ) fail("contents must be {packages: [{name, version, build}], remark}");
  // The format says whether a store is there: 4 carries one, no other does.
  if ((value.format === STORE_FORMAT) !== (value.store !== undefined)) {
    fail(
      value.store === undefined
        ? `store is required in format ${STORE_FORMAT}`
        : `store is only in format ${STORE_FORMAT}`,
    );
  }
  const store = value.store === undefined
    ? undefined
    : parseStorePin(value.store, fail);
  return {
    releaseRepo: value.releaseRepo as string,
    release: value.release as string,
    format: value.format as number,
    sha256: value.sha256 as string,
    size: value.size as number,
    parts: value.parts as string[],
    builtFrom: {
      kernelSha256: built.kernelSha256 as string,
      kernelRev: built.kernelRev as string,
      sealVersion: built.sealVersion as number,
      bootSetup: built.bootSetup as number,
      imageSha256: built.imageSha256 as string,
      pythonSealSha256: built.pythonSealSha256 as string | null,
      pythonSet: built.pythonSet as string | null,
    },
    ...(value.memoryBytes === undefined
      ? {}
      : { memoryBytes: value.memoryBytes as number }),
    ...(contents === undefined
      ? {}
      : { contents: contents as NonNullable<SnapshotPin["contents"]> }),
    ...(value.restorePeakMiB === undefined
      ? {}
      : { restorePeakMiB: value.restorePeakMiB as number }),
    ...(store === undefined ? {} : { store }),
  };
}

/** The snapshot format that carries a YurtFS root store (the memory-only
 * one is src/snapshot_pin.ts FORMAT). Here, not there, because the pin's
 * shape depends on it and src/snapshot_pin.ts imports this module. */
export const STORE_FORMAT = 4;

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
