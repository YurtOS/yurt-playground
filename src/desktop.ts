/**
 * The desktop playground: the deployed site (`dist/`, see
 * scripts/build-static.ts) served from a local port with the same isolation
 * headers Cloudflare Pages applies from `_headers`, plus the native sandbox
 * behind `/desktop.json` and `/ws/*` when the bundle carries a runtime.
 *
 * Unlike the dev server (src/serve.ts) this serves the built tree as-is: the
 * image is already in parts, integrity.json is already written, nothing is
 * computed from public/ or artifacts/.
 */
import { join } from "node:path";
import { documentPolicy, inlineScriptHashes } from "./csp.ts";
import { type DesktopHost, proxyWebSocket } from "./desktop_host.ts";
import { contentType, ISOLATION_HEADERS } from "./serve.ts";

function notFound(): Response {
  return new Response("not found", {
    status: 404,
    headers: ISOLATION_HEADERS,
  });
}

/** `pathname` as a file under `distDir`, or null when it would leave it. */
export function resolveDistPath(
  distDir: string,
  pathname: string,
): string | null {
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
  const resolved = join(distDir, relative);
  if (resolved !== distDir && !resolved.startsWith(`${distDir}/`)) {
    return null;
  }
  return resolved;
}

/** A request handler serving the built site under `distDir`. */
export function handleDistRequest(
  distDir: string,
): (req: Request) => Promise<Response> {
  return async (req) => {
    const url = new URL(req.url);
    let pathname: string;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      return notFound();
    }
    const filePath = resolveDistPath(distDir, pathname);
    if (filePath === null) return notFound();
    let file: Deno.FsFile;
    try {
      file = await Deno.open(filePath);
    } catch {
      return notFound();
    }
    if (!(await file.stat()).isFile) {
      file.close();
      return notFound();
    }
    const path = pathname === "/" ? "/index.html" : pathname;
    const headers: Record<string, string> = {
      ...ISOLATION_HEADERS,
      "content-type": contentType(path),
    };
    if (path.endsWith(".html")) {
      // Same rule as the dev server and `_headers`: a document allows its own
      // inline scripts by hash, and JupyterLite's documents may eval.
      const html = await new Response(file.readable).text();
      headers["Content-Security-Policy"] = documentPolicy(
        path,
        await inlineScriptHashes(html),
      );
      return new Response(html, { headers });
    }
    return new Response(file.readable, { headers });
  };
}

/** Serve `distDir` on a free loopback port. With a native host, the page
 * learns so from `/desktop.json` and its `/ws/*` sockets are relayed to it
 * (src/desktop_host.ts). */
export function startDesktopServer(
  distDir: string,
  host?: DesktopHost,
): { url: string; shutdown: () => Promise<void> } {
  const files = handleDistRequest(distDir);
  const handle = host === undefined ? files : (req: Request) => {
    const path = new URL(req.url).pathname;
    if (path === "/desktop.json") {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            native: true,
            kernelPorts: host.kernelPorts,
            bootMs: host.bootMs,
          }),
          {
            headers: {
              ...ISOLATION_HEADERS,
              "content-type": "application/json; charset=utf-8",
            },
          },
        ),
      );
    }
    if (path.startsWith("/ws/")) {
      return Promise.resolve(proxyWebSocket(req, host));
    }
    return files(req);
  };
  const server = Deno.serve(
    { port: 0, hostname: "127.0.0.1", onListen: () => {} },
    handle,
  );
  const addr = server.addr;
  if (!("port" in addr)) {
    throw new Error("desktop server did not bind a TCP port");
  }
  return {
    url: `http://127.0.0.1:${addr.port}/`,
    shutdown: () => server.shutdown(),
  };
}
