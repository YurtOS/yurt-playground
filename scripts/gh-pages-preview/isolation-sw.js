// The service worker behind isolation.js: a GitHub Pages preview's
// same-origin responses get the isolation headers production's _headers
// gives them (src/serve.ts ISOLATION_HEADERS), so its pages and workers are
// cross-origin isolated. Cross-origin requests are not touched: under
// require-corp they pass by CORS, as on production. Its scope is the whole
// preview, jupyter/ included (scripts/lib/gh_pages_preview.ts turns off
// JupyterLite's own worker), and a Worker's script is matched by its own URL,
// so the coordinators a JupyterLite page starts from the root get it too.
const ISOLATION = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Resource-Policy": "same-origin",
};

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;
  event.respondWith(isolated(request));
});

async function isolated(request) {
  const response = await fetch(request);
  // A navigation's redirect (GitHub Pages adds the slash to a directory)
  // is opaque, and is passed on as it is.
  if (response.type === "opaqueredirect" || response.status === 0) {
    return response;
  }
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(ISOLATION)) {
    headers.set(name, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
