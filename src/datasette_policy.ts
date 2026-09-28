import type { GuestHttpReply, GuestMethod } from "./guest_http.ts";
export function guestDocumentPolicy(hashes: string[]): string {
  if (!hashes.every((h) => /^sha256-[A-Za-z0-9+/]{43}=$/.test(h))) {
    throw new Error("invalid qualified script hash");
  }
  return `default-src 'self'; script-src 'self' ${
    hashes.map((h) => `'${h}'`).join(" ")
  }; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; worker-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'`;
}
function isolation(headers: Headers) {
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  headers.set("Cross-Origin-Embedder-Policy", "require-corp");
  headers.set("Cross-Origin-Resource-Policy", "same-origin");
}
export function guestResponse(
  reply: GuestHttpReply,
  method: GuestMethod,
  hashes: string[],
): Response {
  const headers = new Headers(reply.headers);
  headers.delete("content-security-policy");
  headers.delete("content-security-policy-report-only");
  headers.delete("x-frame-options");
  isolation(headers);
  if (/^text\/html(?:;|$)/i.test(headers.get("content-type") ?? "")) {
    headers.set("Content-Security-Policy", guestDocumentPolicy(hashes));
  }
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
): Response {
  const escape = (s: string) =>
    s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  const body = new TextEncoder().encode(
    `<!doctype html><html lang="en"><meta charset="utf-8"><title>Datasette unavailable</title><h1>Datasette unavailable</h1><p>${
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
  if (status === 405) headers.set("Allow", "GET, HEAD");
  return new Response(method === "HEAD" ? null : body, { status, headers });
}
