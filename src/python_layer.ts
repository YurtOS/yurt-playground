/**
 * Instant Python on later visits (yurt-playground#243): the first visit's
 * Python install, kept as one filesystem layer in the browser.
 *
 * On a slim image the coordinator installs the Python set with the guest's
 * own `pkg` (src/packages.ts), about a minute of guest file creation. Right
 * after that install succeeds, the files it changed -- the kernel's
 * changed-paths log, drained just before and just after -- are read out of
 * the guest by the host and kept as one gzipped tar in the Cache API, keyed
 * by the slim image and the exact releases of the set. On a later visit,
 * when the live index still resolves to that set (or the page is offline),
 * the layer is written straight into the guest's filesystem (seconds) and
 * `pkg` is not run at all.
 *
 * Trust: the layer is what this browser's own guest `pkg` installed after
 * verifying every signature; it is kept next to the archive cache, under
 * the same origin, and checked against its own sha256 before it is used.
 * Nothing here is downloaded from anywhere.
 */
import type { LayerEntry } from "./stage.ts";

/** What a layer never holds, whatever the guest touched there during the
 * install: the user's files (their home, root's), scratch (/tmp, the
 * page's exec files), the kernel's own trees, and the page's staged
 * repository copy (src/packages.ts `STAGING_DIR`, removed after each run).
 * Everything else the install changed is the install's: what `pkg` put in
 * place (/usr, /etc/pip.conf) and its records (/var/lib/yurt-pkg, what
 * `pkg list` reads; the cached index under /var/cache/yurt-pkg). */
export const LAYER_EXCLUDED = [
  "/tmp/",
  "/var/tmp/",
  "/home/",
  "/root/",
  "/dev/",
  "/proc/",
  "/sys/",
  "/run/",
  "/var/cache/yurt-pkg/browser/",
];

export function inLayer(path: string): boolean {
  return path !== "/" && path.startsWith("/") &&
    !LAYER_EXCLUDED.some((root) =>
      path.startsWith(root) || path === root.slice(0, -1)
    );
}

/** How the host reads the guest's filesystem (src/stage.ts, as the
 * kernel). */
export type GuestFs = {
  stat(path: string):
    | {
      type: "dir" | "file" | "symlink" | "other";
      mode: number;
      uid: number;
      gid: number;
      size: number;
      mtime: number;
    }
    | undefined;
  readFile(path: string, size: number): Uint8Array;
  readlink(path: string): string;
  readdir(path: string): string[];
};

/** The layer for `touched` paths: each one that still exists and is
 * {@link inLayer}, and everything beneath a touched directory (a directory
 * renamed into place is one touched path, its contents none). Sorted, each
 * path once. */
export function captureLayer(fs: GuestFs, touched: string[]): LayerEntry[] {
  const entries = new Map<string, LayerEntry>();
  const visit = (path: string) => {
    if (entries.has(path) || !inLayer(path)) return;
    const stat = fs.stat(path);
    if (stat === undefined || stat.type === "other") return;
    const common = {
      path,
      mode: stat.mode,
      uid: stat.uid,
      gid: stat.gid,
      mtime: stat.mtime,
    };
    if (stat.type === "dir") {
      entries.set(path, { type: "dir", ...common });
      for (const name of fs.readdir(path)) visit(`${path}/${name}`);
    } else if (stat.type === "file") {
      entries.set(path, {
        type: "file",
        ...common,
        bytes: fs.readFile(path, stat.size),
      });
    } else {
      entries.set(path, {
        type: "symlink",
        ...common,
        target: fs.readlink(path),
      });
    }
  };
  for (const path of touched) visit(path.replace(/\/+$/, ""));
  return [...entries.values()].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0
  );
}

const BLOCK = 512;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function octal(value: number, width: number): string {
  return value.toString(8).padStart(width - 1, "0") + "\0";
}

function header(
  name: string,
  type: string,
  size: number,
  entry: { mode: number; uid: number; gid: number; mtime: number },
  linkname = "",
): Uint8Array {
  const block = new Uint8Array(BLOCK);
  const put = (text: string, at: number, width: number) =>
    block.set(encoder.encode(text).subarray(0, width), at);
  put(name, 0, 100);
  put(octal(entry.mode & 0o7777, 8), 100, 8);
  put(octal(entry.uid, 8), 108, 8);
  put(octal(entry.gid, 8), 116, 8);
  put(octal(size, 12), 124, 12);
  put(octal(Math.max(0, Math.trunc(entry.mtime)), 12), 136, 12);
  put("        ", 148, 8);
  put(type, 156, 1);
  put(linkname, 157, 100);
  put("ustar\x0000", 257, 8);
  let sum = 0;
  for (const byte of block) sum += byte;
  put(octal(sum, 7) + " ", 148, 8);
  return block;
}

/** A PAX record: `<len> <key>=<value>\n`, where len counts itself. */
function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  let length = encoder.encode(body).byteLength;
  length += String(length).length;
  if (String(length).length !== String(length - String(length).length).length) {
    length += 1;
  }
  return `${length}${body}`;
}

function padded(bytes: Uint8Array): Uint8Array[] {
  const rest = bytes.byteLength % BLOCK;
  return rest === 0 ? [bytes] : [bytes, new Uint8Array(BLOCK - rest)];
}

/** `entries` as a tar (ustar, with a PAX header for a path or link target
 * that does not fit). */
export function encodeTar(entries: LayerEntry[]): Uint8Array {
  const parts = tarParts(entries);
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}

/** {@link encodeTar} as its parts, in order, unjoined: a layer is over
 * 100 MiB, and gzip reads the parts as one stream. */
function tarParts(entries: LayerEntry[]): Uint8Array[] {
  const parts: Uint8Array[] = [];
  for (const entry of entries) {
    const name = entry.path.replace(/^\/+/, "") +
      (entry.type === "dir" ? "/" : "");
    const target = entry.type === "symlink" ? entry.target : "";
    const records =
      (encoder.encode(name).byteLength > 100 ? paxRecord("path", name) : "") +
      (encoder.encode(target).byteLength > 100
        ? paxRecord("linkpath", target)
        : "");
    if (records !== "") {
      const pax = encoder.encode(records);
      parts.push(header("PaxHeader", "x", pax.byteLength, entry));
      parts.push(...padded(pax));
    }
    if (entry.type === "file") {
      parts.push(header(name, "0", entry.bytes.byteLength, entry));
      parts.push(...padded(entry.bytes));
    } else if (entry.type === "dir") {
      parts.push(header(name, "5", 0, entry));
    } else {
      parts.push(header(name, "2", 0, entry, target));
    }
  }
  parts.push(new Uint8Array(BLOCK * 2));
  return parts;
}

function field(block: Uint8Array, at: number, width: number): string {
  const raw = block.subarray(at, at + width);
  const end = raw.indexOf(0);
  return decoder.decode(end < 0 ? raw : raw.subarray(0, end));
}

function number(block: Uint8Array, at: number, width: number): number {
  const text = field(block, at, width).trim();
  return text === "" ? 0 : Number.parseInt(text, 8);
}

/** A tar from {@link encodeTar} back into entries; throws on anything
 * else, or on a path that is not absolute-clean (`..`, empty parts). */
export function decodeTar(tar: Uint8Array): LayerEntry[] {
  const entries: LayerEntry[] = [];
  let pax: Record<string, string> = {};
  let at = 0;
  while (at + BLOCK <= tar.byteLength) {
    const block = tar.subarray(at, at + BLOCK);
    at += BLOCK;
    if (block.every((byte) => byte === 0)) break;
    const size = number(block, 124, 12);
    const type = field(block, 156, 1);
    const data = tar.subarray(at, at + size);
    if (data.byteLength !== size) throw new Error("layer: truncated tar");
    at += Math.ceil(size / BLOCK) * BLOCK;
    if (type === "x") {
      pax = {};
      for (const line of decoder.decode(data).split("\n")) {
        const match = /^\d+ ([^=]+)=(.*)$/.exec(line);
        if (match !== null) pax[match[1]] = match[2];
      }
      continue;
    }
    const prefix = field(block, 345, 155);
    const raw = pax.path ??
      (prefix !== "" ? `${prefix}/` : "") + field(block, 0, 100);
    const parts = raw.split("/").filter((part) => part !== "");
    if (parts.length === 0 || parts.some((p) => p === "." || p === "..")) {
      throw new Error(`layer: bad path ${JSON.stringify(raw)}`);
    }
    const common = {
      path: `/${parts.join("/")}`,
      mode: number(block, 100, 8),
      uid: number(block, 108, 8),
      gid: number(block, 116, 8),
      mtime: number(block, 136, 12),
    };
    if (type === "0" || type === "") {
      entries.push({ type: "file", ...common, bytes: data });
    } else if (type === "5") {
      entries.push({ type: "dir", ...common });
    } else if (type === "2") {
      entries.push({
        type: "symlink",
        ...common,
        target: pax.linkpath ?? field(block, 157, 100),
      });
    } else {
      throw new Error(`layer: unsupported tar entry type ${type}`);
    }
    pax = {};
  }
  return entries;
}

async function through(
  parts: Uint8Array[],
  stream: CompressionStream | DecompressionStream,
): Promise<Uint8Array> {
  return new Uint8Array(
    await new Response(
      new Blob(parts as BlobPart[]).stream().pipeThrough(stream),
    ).arrayBuffer(),
  );
}

export const gzip = (bytes: Uint8Array) =>
  through([bytes], new CompressionStream("gzip"));
const gzipTar = (entries: LayerEntry[]) =>
  through(tarParts(entries), new CompressionStream("gzip"));
export const gunzip = (bytes: Uint8Array) =>
  through([bytes], new DecompressionStream("gzip"));

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(
    new Uint8Array(digest),
    (b) => b.toString(16).padStart(2, "0"),
  )
    .join("");
}

/** A layer's key: the slim image it was installed on, and the exact
 * releases of the set. Another image or another build of any member is
 * another key. */
export function layerKey(
  imageSha256: string,
  releases: { name: string; version: string; build: string; sha256: string }[],
): string {
  // The archive's sha256 too: a release republished under the same version
  // and build is another install.
  const specs = releases.map((r) =>
    `${r.name}@${r.version}-${r.build}:${r.sha256.toLowerCase().slice(0, 16)}`
  ).sort();
  return `${imageSha256.toLowerCase()}/${specs.join("+")}`;
}

/** Where layers are kept: one at a time (a new one replaces the last),
 * gzipped, with its sha256 and key beside it. */
export type LayerStore = {
  /** The stored layer's key, when it was installed on `imageSha256`. */
  storedKey(imageSha256: string): Promise<string | undefined>;
  /** The layer under `key`, checked against its sha256; `undefined` when
   * there is none, or it is not intact (then it is dropped). */
  get(key: string): Promise<LayerEntry[] | undefined>;
  put(key: string, entries: LayerEntry[]): Promise<void>;
  drop(): Promise<void>;
};

const LAYER_CACHE = "yurt-python-layer-v1";
const LAYER_URL = "https://yurt-python-layer.invalid/layer.tar.gz";
const KEY_HEADER = "x-yurt-layer-key";
const SHA_HEADER = "x-yurt-layer-sha256";

/** The Cache API store; `undefined` where the page has none (an insecure
 * context, storage blocked). */
export async function browserLayerStore(): Promise<LayerStore | undefined> {
  let cache: Cache;
  try {
    cache = await caches.open(LAYER_CACHE);
  } catch {
    return undefined;
  }
  const stored = async () => {
    try {
      return await cache.match(LAYER_URL) ?? undefined;
    } catch {
      return undefined;
    }
  };
  const drop = async () => {
    try {
      await cache.delete(LAYER_URL);
    } catch {
      // Nothing to drop, or storage gone.
    }
  };
  return {
    async storedKey(imageSha256) {
      const key = (await stored())?.headers.get(KEY_HEADER) ?? undefined;
      return key?.startsWith(`${imageSha256.toLowerCase()}/`) ? key : undefined;
    },
    async get(key) {
      const response = await stored();
      if (response === undefined || response.headers.get(KEY_HEADER) !== key) {
        return undefined;
      }
      try {
        const gz = new Uint8Array(await response.arrayBuffer());
        if (await sha256Hex(gz) !== response.headers.get(SHA_HEADER)) {
          await drop();
          return undefined;
        }
        return decodeTar(await gunzip(gz));
      } catch {
        await drop();
        return undefined;
      }
    },
    async put(key, entries) {
      const gz = await gzipTar(entries);
      await cache.put(
        LAYER_URL,
        new Response(gz as BodyInit, {
          headers: {
            "content-type": "application/gzip",
            [KEY_HEADER]: key,
            [SHA_HEADER]: await sha256Hex(gz),
          },
        }),
      );
    },
    drop,
  };
}

/** A stored layer that did not work in this sandbox: it is dropped, and
 * the sandbox -- with part or all of it written, and `pkg`'s records saying
 * the set is installed -- cannot take a `pkg` install, so the retry is in a
 * fresh sandbox (src/coordinator_worker.ts, as after a stall). */
export class LayerFailed extends Error {
  constructor(cause: string) {
    super(
      `this browser's earlier install did not work here (${cause}); ` +
        "the next try installs it afresh in a fresh sandbox",
    );
    this.name = "LayerFailed";
  }
}

/** What {@link installWithLayer} needs from the coordinator. */
export type LayerInstallDeps<E> = {
  /** The sandbox's layer operations (src/boot.ts); absent: no layers. */
  layer?: {
    drainChanged(): string[];
    capture(touched: string[]): E[];
    apply(entries: E[]): void;
  };
  store?: {
    storedKey(imageSha256: string): Promise<string | undefined>;
    get(key: string): Promise<E[] | undefined>;
    put(key: string, entries: E[]): Promise<void>;
    drop(): Promise<void>;
  };
  /** The slim image's sha256 (the site's pins); absent: no layers. */
  image?: string;
  /** No package install has run in this sandbox yet -- not Python's, not
   * the Packages panel's. Only then may a layer be used (its records would
   * replace pkg's, leaving what was installed unmanaged) or kept (what
   * `pkg` wrote would not be the whole set, while its records, which the
   * layer copies, would list more). */
  pristine: boolean;
  /** The key the live index resolves the set to now. `undefined` when the
   * repository answered but names no usable set (yanked, removed): then no
   * layer is used either, and `pkg` says why. Throws when the repository
   * cannot be reached in time. */
  liveKey(): Promise<string | undefined>;
  /** The guest's own install; `between` runs right before `pkg` and right
   * after it succeeded. The caller runs all of this in one turn of the
   * install queue, so nothing else installs meanwhile. */
  install(between: { before(): void; after(): void }): Promise<void>;
  /** Whether the sandbox has a python3 now (src/coordinator_start.ts):
   * `undefined` when the probe could not tell. */
  probe(): Promise<boolean | undefined>;
  progress(text: string): void;
};

/** Install the Python set: from this browser's stored layer when it is
 * the set the live index resolves to (or, when the index cannot be had,
 * the one stored for this image), else with the guest's `pkg` -- keeping
 * what that install wrote as the layer for the next visit. A layer that
 * does not apply, or leaves no python3, is dropped and fails as
 * {@link LayerFailed}. Failing to keep a layer fails nothing. */
export async function installWithLayer<E>(
  deps: LayerInstallDeps<E>,
): Promise<"layer" | "pkg"> {
  const { layer, store, image } = deps;
  let live: string | undefined;
  if (
    layer !== undefined && store !== undefined && image !== undefined &&
    deps.pristine
  ) {
    let key: string | undefined;
    try {
      live = await deps.liveKey();
      key = live;
    } catch {
      // No live answer: the layer this browser kept for this image, if any.
      key = await store.storedKey(image);
    }
    const entries = key === undefined ? undefined : await store.get(key);
    if (entries !== undefined) {
      deps.progress("Python: installing from this browser's earlier install");
      let cause: string;
      try {
        layer.apply(entries);
        // A probe that could not tell (it timed out) is no reason to throw
        // a good layer away; the kernel's start tells.
        if (await deps.probe() !== false) return "layer";
        cause = "no python3 after it";
      } catch (error) {
        cause = error instanceof Error ? error.message : String(error);
      }
      await store.drop();
      throw new LayerFailed(cause);
    }
  }
  const keep = layer !== undefined && store !== undefined &&
    live !== undefined;
  let drained = false;
  let captured: E[] | undefined;
  await deps.install({
    before: () => {
      if (!keep) return;
      try {
        layer!.drainChanged();
        drained = true;
      } catch {
        // Not kept; the install goes ahead.
      }
    },
    after: () => {
      if (!drained) return;
      try {
        captured = layer!.capture(layer!.drainChanged());
      } catch {
        // Not kept; the next visit installs with pkg.
      }
    },
  });
  // Nothing written (pkg found the set installed): nothing to keep.
  if (live !== undefined && captured !== undefined && captured.length > 0) {
    deps.progress("Python: keeping the install for the next visit");
    try {
      await store!.put(live, captured);
    } catch {
      // Storage full or blocked: the next visit installs with pkg.
    }
  }
  return "pkg";
}
