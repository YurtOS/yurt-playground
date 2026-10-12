import type { GuestHttpReply, GuestMethod } from "./guest_http.ts";
export function guestDocumentPolicy(hashes: string[]): string {
  if (!hashes.every((h) => /^sha256-[A-Za-z0-9+/]{43}=$/.test(h))) {
    throw new Error("invalid qualified script hash");
  }
  return `default-src 'self'; script-src 'self' ${
    hashes.map((h) => `'${h}'`).join(" ")
  }; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; worker-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'; sandbox allow-scripts allow-same-origin allow-forms allow-downloads`;
}
function isolation(headers: Headers) {
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  headers.set("Cross-Origin-Embedder-Policy", "require-corp");
  headers.set("Cross-Origin-Resource-Policy", "same-origin");
}
const ALLOWED_RESPONSE = new Set([
  "content-type",
  "content-length",
  "content-language",
  "cache-control",
  "etag",
  "last-modified",
  "location",
  "content-disposition",
  "vary",
  "accept-ranges",
  "content-range",
  "allow",
  "www-authenticate",
]);
const REPORTED_DROPS = new Set([
  "refresh",
  "link",
  "service-worker-allowed",
  "clear-site-data",
  "report-to",
  "reporting-endpoints",
  "nel",
  "permissions-policy",
  "origin-agent-cluster",
  "speculation-rules",
  "set-cookie",
]);
export function guestResponse(
  reply: GuestHttpReply,
  method: GuestMethod,
  hashes: string[],
  onDrop?: (header: string) => void,
): Response {
  const headers = new Headers();
  for (const [name, value] of reply.headers) {
    const key = name.toLowerCase();
    if (ALLOWED_RESPONSE.has(key)) headers.append(key, value);
    else if (REPORTED_DROPS.has(key) || key.startsWith("access-control-")) {
      onDrop?.(key);
    }
  }
  headers.set("Content-Security-Policy", guestDocumentPolicy(hashes));
  headers.set("X-Content-Type-Options", "nosniff");
  isolation(headers);
  const body = method === "HEAD" || reply.status === 204 || reply.status === 304
    ? null
    : reply.body;
  return new Response(body, { status: reply.status, headers });
}
export function bridgeErrorResponse(
  status: number,
  message: string,
  method: GuestMethod,
  hashes: string[],
  title: string,
): Response {
  const escape = (s: string) =>
    s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  const body = new TextEncoder().encode(
    `<!doctype html><html lang="en"><meta charset="utf-8"><title>${
      escape(title)
    } unavailable</title><h1>${escape(title)} unavailable</h1><p>${
      escape(message)
    }</p></html>`,
  );
  const headers = new Headers({
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": String(body.length),
    "Cache-Control": "no-store",
    "Content-Security-Policy": guestDocumentPolicy(hashes),
  });
  isolation(headers);
  if (status === 405) {
    headers.set("Allow", "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS");
  }
  return new Response(method === "HEAD" ? null : body, { status, headers });
}
