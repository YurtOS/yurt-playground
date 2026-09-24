import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  contentSecurityPolicy,
  documentPolicy,
  inlineScriptHashes,
} from "./csp.ts";
import {
  imagePartIndex,
  imagePartRange,
  imagePartsManifest,
  PYTHON_SEAL_NAME,
} from "./image_parts.ts";
import { IMAGE_NAME, integrityManifest } from "./integrity.ts";
import { LOCAL_MODELS } from "./llm_models.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = join(repoRoot, "public");
const artifactsDir = join(repoRoot, "artifacts");

export const ISOLATION_HEADERS = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  // Nested module workers (guest WorkerHost) are COEP subresources.
  "Cross-Origin-Resource-Policy": "same-origin",
  // Non-document responses carry the policy too: a worker script's own CSP
  // is what governs the worker.
  "Content-Security-Policy": contentSecurityPolicy(),
};

/** xterm's stylesheet, served from the npm package rather than copied into
 * public/. The static build copies it from here too. */
export const XTERM_CSS_PATH = join(
  repoRoot,
  "node_modules/@xterm/xterm/css/xterm.css",
);

const ARTIFACT_FILES: Record<string, string> = {
  "/pins.json": join(artifactsDir, "pins.json"),
  "/yurt_kernel.wasm": join(artifactsDir, "yurt_kernel.wasm"),
  "/playground.yurtimg": join(artifactsDir, "playground.yurtimg"),
  "/xterm.css": XTERM_CSS_PATH,
};

export function resolvePlaygroundPath(pathname: string): string | null {
  if (pathname in ARTIFACT_FILES) return ARTIFACT_FILES[pathname];
  const relative = (pathname === "/" ? "index.html" : pathname).replace(
    /^\/+/,
    "",
  );
  if (
    relative.includes("\0") || relative.includes("\\") ||
    relative.split("/").includes("..")
  ) {
    return null;
  }
  const resolved = join(publicDir, relative);
  if (resolved !== publicDir && !resolved.startsWith(`${publicDir}/`)) {
    return null;
  }
  return resolved;
}

export function contentType(path: string): string {
  if (path.endsWith(".html")) return "text/html; charset=utf-8";
  if (path.endsWith(".js") || path.endsWith(".ts")) {
    return "text/javascript; charset=utf-8";
  }
  if (path.endsWith(".css")) return "text/css; charset=utf-8";
  if (path.endsWith(".wasm")) return "application/wasm";
  if (path.endsWith(".svg")) return "image/svg+xml";
  if (path.endsWith(".yurtimg")) return "application/octet-stream";
  if (path.endsWith(".json")) return "application/json; charset=utf-8";
  return "application/octet-stream";
}

function notFound(): Response {
  return new Response("not found", {
    status: 404,
    headers: ISOLATION_HEADERS,
  });
}

/** Cloudflare Pages' directory rule, which both local servers follow so a
 * link works the same everywhere: `/dir` is sent to `/dir/` with the query
 * kept, and `/dir/` serves `dir/index.html`. Notebook 7 opens "New Console
 * for Notebook" at `consoles?path=…`, and the app's assets are relative, so
 * only the slash form can serve it (#73). Returns the redirect, the index
 * file to serve, or null when `resolved` is not a directory. */
export async function directoryRule(
  resolved: string,
  url: URL,
): Promise<Response | string | null> {
  const stat = await Deno.stat(resolved).catch(() => null);
  if (stat === null || !stat.isDirectory) return null;
  if (!url.pathname.endsWith("/")) {
    return new Response(null, {
      status: 308,
      headers: {
        ...ISOLATION_HEADERS,
        location: `${url.pathname}/${url.search}`,
      },
    });
  }
  return join(resolved, "index.html");
}

/** The files the static build publishes in parts (Cloudflare Pages' 25 MiB
 * cap): the image, and the notebook kernel's sealable CPython. */
const PARTED_FILES: Record<string, string> = {
  [IMAGE_NAME]: join(artifactsDir, IMAGE_NAME),
  [PYTHON_SEAL_NAME]: join(publicDir, PYTHON_SEAL_NAME),
};

/** The parts the static build publishes, sliced from the single file so the
 * page's fetch path is the same here and deployed. */
async function handleImagePart(pathname: string): Promise<Response | null> {
  const relative = pathname.replace(/^\/+/, "");
  const name = Object.keys(PARTED_FILES).find((candidate) =>
    relative === `${candidate}.parts.json` ||
    imagePartIndex(relative, candidate) !== undefined
  );
  if (name === undefined) return null;
  const isManifest = relative === `${name}.parts.json`;
  const index = imagePartIndex(relative, name);
  let file: Deno.FsFile;
  try {
    file = await Deno.open(PARTED_FILES[name]);
  } catch {
    return notFound();
  }
  try {
    const size = (await file.stat()).size;
    if (isManifest) {
      return new Response(
        JSON.stringify(imagePartsManifest(name, size)),
        {
          headers: {
            ...ISOLATION_HEADERS,
            "Content-Type": "application/json; charset=utf-8",
          },
        },
      );
    }
    const range = imagePartRange(index!, size);
    if (range === undefined) return notFound();
    const bytes = new Uint8Array(range[1] - range[0]);
    await file.seek(range[0], Deno.SeekMode.Start);
    let read = 0;
    while (read < bytes.byteLength) {
      const n = await file.read(bytes.subarray(read));
      if (n === null) break;
      read += n;
    }
    return new Response(bytes.subarray(0, read), {
      headers: {
        ...ISOLATION_HEADERS,
        "Content-Type": "application/octet-stream",
      },
    });
  } finally {
    file.close();
  }
}

/** The dev-server counterpart of the static build's integrity.json,
 * computed from the files being served so it is never stale. */
async function handleIntegrity(): Promise<Response> {
  const manifest = await integrityManifest((name) => {
    const path = resolvePlaygroundPath(`/${name}`);
    if (path === null) throw new Error(`no such file: ${name}`);
    return Deno.readFile(path);
  }, null);
  return new Response(JSON.stringify(manifest, null, 2), {
    headers: {
      ...ISOLATION_HEADERS,
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

/** LiteRT-LM's wasm builds, straight from the npm package deno.lock pins. */
export const LITERT_WASM_DIR = join(
  repoRoot,
  "node_modules/@litert-lm/core/wasm",
);

/** What `/llm/models.json` lists: every pin. The weights come from Hugging
 * Face, so a site that ships the runtime offers them all. */
export function offeredModelIds(): string[] {
  return LOCAL_MODELS.map((m) => m.id);
}

/** The local agent's runtime (#140): `/llm/models.json`, the emscripten glue,
 * and each `.wasm` gzipped as `.wasm.gz`, the form the static build ships
 * (a build is 21-34 MB; Cloudflare Pages refuses a file over 25 MiB). */
async function handleLlmFile(pathname: string): Promise<Response | null> {
  if (!pathname.startsWith("/llm/")) return null;
  const relative = pathname.slice("/llm/".length);
  if (relative === "models.json") {
    return new Response(JSON.stringify(offeredModelIds()), {
      headers: {
        ...ISOLATION_HEADERS,
        "Content-Type": "application/json; charset=utf-8",
      },
    });
  }
  const name = /^wasm\/([\w.-]+\.(js|wasm\.gz))$/.exec(relative)?.[1];
  if (name === undefined) return notFound();
  let file: Deno.FsFile;
  try {
    file = await Deno.open(join(LITERT_WASM_DIR, name.replace(/\.gz$/, "")));
  } catch {
    return notFound();
  }
  const gzip = name.endsWith(".gz");
  return new Response(
    gzip
      ? file.readable.pipeThrough(new CompressionStream("gzip"))
      : file.readable,
    {
      headers: {
        ...ISOLATION_HEADERS,
        "Content-Type": gzip ? "application/gzip" : contentType(name),
      },
    },
  );
}

export async function handlePlaygroundRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return notFound();
  }
  const llm = await handleLlmFile(pathname);
  if (llm !== null) return llm;
  if (pathname === "/integrity.json") {
    try {
      return await handleIntegrity();
    } catch {
      return notFound();
    }
  }
  const part = await handleImagePart(pathname);
  if (part !== null) return part;
  let filePath = resolvePlaygroundPath(pathname);
  if (filePath === null) return notFound();
  const directory = await directoryRule(filePath, url);
  if (directory instanceof Response) return directory;
  if (directory !== null) filePath = directory;
  try {
    const file = await Deno.readFile(filePath);
    // The document's policy keys on the path served (`/jupyter/…` may eval).
    const path = directory !== null
      ? `${url.pathname}index.html`
      : url.pathname === "/"
      ? "/index.html"
      : url.pathname;
    const headers: Record<string, string> = {
      ...ISOLATION_HEADERS,
      "content-type": contentType(path),
    };
    if (path.endsWith(".html")) {
      // A document's policy allows its own inline scripts by hash, computed
      // from the file being served so a rebuilt JupyterLite site needs no
      // restart.
      headers["Content-Security-Policy"] = documentPolicy(
        path,
        await inlineScriptHashes(new TextDecoder().decode(file)),
      );
    }
    return new Response(file, { headers });
  } catch {
    return notFound();
  }
}

export function startPlaygroundServer(
  port = 4173,
): { url: string; shutdown: () => Promise<void> } {
  const server = Deno.serve(
    { port, hostname: "127.0.0.1", onListen: () => {} },
    handlePlaygroundRequest,
  );
  const addr = server.addr;
  if (!("port" in addr)) {
    throw new Error("playground server did not bind a TCP port");
  }
  return {
    url: `http://127.0.0.1:${addr.port}`,
    shutdown: () => server.shutdown(),
  };
}
