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
} from "./image_parts.ts";

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

function contentType(path: string): string {
  if (path.endsWith(".html")) return "text/html; charset=utf-8";
  if (path.endsWith(".js") || path.endsWith(".ts")) {
    return "text/javascript; charset=utf-8";
  }
  if (path.endsWith(".css")) return "text/css; charset=utf-8";
  if (path.endsWith(".wasm")) return "application/wasm";
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

const IMAGE_NAME = "playground.yurtimg";

/** The image parts the static build publishes, sliced from the single
 * artifacts/ file so the page's fetch path is the same here and deployed. */
async function handleImagePart(pathname: string): Promise<Response | null> {
  const relative = pathname.replace(/^\/+/, "");
  const isManifest = relative === `${IMAGE_NAME}.parts.json`;
  const index = imagePartIndex(relative, IMAGE_NAME);
  if (!isManifest && index === undefined) return null;
  let file: Deno.FsFile;
  try {
    file = await Deno.open(ARTIFACT_FILES[`/${IMAGE_NAME}`]);
  } catch {
    return notFound();
  }
  try {
    const size = (await file.stat()).size;
    if (isManifest) {
      return new Response(
        JSON.stringify(imagePartsManifest(IMAGE_NAME, size)),
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

export async function handlePlaygroundRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return notFound();
  }
  const part = await handleImagePart(pathname);
  if (part !== null) return part;
  const filePath = resolvePlaygroundPath(pathname);
  if (filePath === null) return notFound();
  try {
    const file = await Deno.readFile(filePath);
    const path = url.pathname === "/" ? "/index.html" : url.pathname;
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
