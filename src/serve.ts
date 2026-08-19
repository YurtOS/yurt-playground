import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = join(repoRoot, "public");
const artifactsDir = join(repoRoot, "artifacts");

export const ISOLATION_HEADERS = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  // Nested module workers (guest WorkerHost) are COEP subresources.
  "Cross-Origin-Resource-Policy": "same-origin",
};

const ARTIFACT_FILES: Record<string, string> = {
  "/pins.json": join(artifactsDir, "pins.json"),
  "/yurt_kernel.wasm": join(artifactsDir, "yurt_kernel.wasm"),
  "/playground.yurtimg": join(artifactsDir, "playground.yurtimg"),
  "/xterm.css": join(repoRoot, "node_modules/@xterm/xterm/css/xterm.css"),
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

export async function handlePlaygroundRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return notFound();
  }
  const filePath = resolvePlaygroundPath(pathname);
  if (filePath === null) return notFound();
  try {
    const file = await Deno.readFile(filePath);
    const path = url.pathname === "/" ? "/index.html" : url.pathname;
    return new Response(file, {
      headers: {
        ...ISOLATION_HEADERS,
        "content-type": contentType(path),
      },
    });
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
