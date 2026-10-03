# Guest HTTP preview: generic "Yurtify" for web apps

Status: draft, revised after design review (round 1 on PR #185). Issue:
[#168](https://github.com/YurtOS/yurt-playground/issues/168). Builds on the
scoped service-worker bridge from #173 (draft PR #176), which already serves
unmodified upstream Datasette from the guest.

## Goal

Run an ordinary web application that listens on `127.0.0.1:<port>` inside the
guest and use it from the browser tab without patching the application. The
bridge maps a browser-visible path to that guest port; the app keeps seeing
localhost. Application changes are limited to configuration the app already
supports (a base path), never code patches.

Non-goals: hosted servers, host OS TCP, guest egress, a general reverse proxy.

## What exists (verified against #176)

- `dialSandboxPort` gives the page a raw byte stream to a guest listener. The
  port comes from coordinator state (`session.guestPorts.datasette`), never from
  message content.
- `src/guest_http.ts`: bounded HTTP/1.1 client. GET/HEAD only, allow-listed
  request headers, 16 MiB body limit, path validation pinned to
  `/apps/datasette/<uuid>/` and port 8001. It does **not** follow redirects: 3xx
  pass through with `Location` rewritten, and a `Location` outside the prefix or
  guest origin is a 502. (The 4-redirect loop is in the Datasette readiness
  probe.) Any guest `Set-Cookie`, in headers or trailers, is currently a 502
  ("guest cookies unsupported").
- `src/datasette_service_worker.ts` + `datasette_routes.ts`: the SW intercepts
  `/apps/datasette/<uuid>/**` and relays to the owning tab over a `MessagePort`;
  owner binding, nonce recovery, heartbeats.
- `src/datasette_policy.ts`: strips guest CSP and X-Frame-Options, adds
  COOP/COEP/CORP, and applies `script-src 'self' <hashes>` **only to
  `text/html`**. `'self'` is the playground origin, so any `.js` the guest
  serves also runs. The iframe is
  `sandbox="allow-scripts allow-same-origin allow-forms allow-downloads"`.
- `src/datasette.ts`: resident-process supervisor (seed, spawn, readiness, stop,
  reset); Datasette-specific only in its commands and probe.

## Security model (read first)

Guest code can come from untrusted packages. With `allow-same-origin` and
`script-src 'self'`, a guest-served script reaches `window.parent`, the
coordinator, `window.yurt`, other apps' frames (same origin) and all origin
storage. That is acceptable only for a **qualified** app: a pinned, audited
package whose static assets are known (Datasette today). Therefore:

- Only qualified apps are enabled. Arbitrary or unqualified apps stay disabled
  until real origin isolation exists (see section 8).
- Qualified apps still get defense in depth (section 6).
- The registry of qualified apps (id, port, policy) is static in the page bundle
  and pinned with the image; it is never read from the guest.

## Design

### 1. Addressing: `/apps/<app>/<session>/`

Path-prefix mount on the playground origin (a virtual origin per app needs
wildcard DNS and breaks COOP/COEP). `<app>` is a registry id; `<session>` is a
per-start UUID, so owner state and the cookie jar die with the process. Reserved
paths for the SW script and the unavailable page live outside any app id
(`/apps/_bridge/...`).

Apps must be prefix-aware through their own configuration (Datasette `base_url`,
Flask `APPLICATION_ROOT`, Django `FORCE_SCRIPT_NAME`, uvicorn `--root-path`,
Jupyter `base_url`). No strip-prefix mode in phase 1: apps that are not
prefix-aware almost always emit root-absolute URLs, which cannot work without
body rewriting. `Host` is `127.0.0.1:<port>`.

### 2. Registry and app supervisor

A static record per qualified app: `id`, guest `port`, readiness predicate,
document policy. A shared `ResidentApp` supervisor extracted from
`DatasetteDemo` owns spawn, readiness, stop-releases-listener and reset; each
app supplies its commands. The port lives only in coordinator/registry state,
never in page or SW messages. Before serving, the coordinator verifies the
listener belongs to the spawned process (pid file plus a request to the app's
own readiness endpoint); a port already held by a user-started server fails the
start instead of being served. Datasette is entry one; a stdlib `wsgiref`
preview app is entry two (the #168 demo).

Multiple apps: owner registry keyed by `(app, session)`; one tab may own
several; limits per session and global (apps, in-flight requests); stop and
reset clean up each app's owner, jar and pending requests.

### 3. Methods and request bodies

Allow `GET HEAD POST PUT PATCH DELETE OPTIONS`. The SW reads `request.body` with
a byte counter, rejects with 413 past 16 MiB (and up front when `Content-Length`
already exceeds it), and transfers the `ArrayBuffer` SW → owner → coordinator
without copies. The client sends an explicit `Content-Length`; browser-chunked
bodies are buffered, never forwarded chunked. In-flight requests are capped (per
session, global); excess gets 503. No streaming in phase 1, so "back-pressure"
means that cap plus buffering.

Request header allow-list: accept, accept-language, if-none-match,
if-modified-since, **range, if-range**, content-type, x-requested-with,
authorization. `Cookie` is not allow-listed: the browser never exposes it to a
SW (forbidden header) and the bridge injects its own (section 5). Dropped:
hop-by-hop headers, `Upgrade`, `Expect`, proxy headers, anything else.

`Origin`/`Referer`: the bridge writes the raw guest request itself. When the
initiating client (resolved from `event.clientId`, or `request.referrer` for
navigations) is under the same `/apps/<app>/<session>/` prefix, it sends
`Origin`/`Referer` = `http://127.0.0.1:<port>` so the app's CSRF/Host checks
behave as on Linux. For any other initiator (the page, another app) it sends
`Origin: null` and injects no cookies, so the app's origin check keeps
protecting it from other same-origin documents.

### 4. Redirects

Unchanged, 3xx pass through. `Location` handling is explicit: an absolute URL on
the guest origin or a path inside the prefix is mapped to the prefix; a
root-absolute path **outside** the prefix is an escape and stays a 502 (it would
otherwise double-prefix). Browser follows and replays POST/redirect/GET.

### 5. Cookies: bridge-managed jar

Browsers cannot do this for us: `Set-Cookie` is a forbidden response header name
and a synthetic SW response never feeds the cookie store, and `Cookie` is a
forbidden request header attached after the SW. So:

- A jar keyed by `(app, session)` lives in the owner page/coordinator (the SW is
  terminated when idle, which is why owner recovery exists). It parses guest
  `Set-Cookie` per RFC 6265 (Path, Max-Age/Expires; bounded size and count), is
  injected as `Cookie` on relayed requests from same-prefix initiators only
  (section 3), and is cleared on stop/reset.
- `Set-Cookie` is stripped from what reaches the browser. Cookies are
  effectively HttpOnly: `document.cookie` never sees them. `Secure` is satisfied
  (plain http to 127.0.0.1 inside the sandbox); `SameSite` is ignored because
  the bridge enforces scope itself.
- Consequence, stated up front: apps whose JavaScript reads a cookie break (e.g.
  Django AJAX reading `csrftoken` into `X-CSRFToken`). Form-field CSRF (Django
  forms, Datasette `asgi-csrf`) works.
- This removes the current 502 on guest cookies.

### 6. Response policy (defense in depth, qualified apps)

- Response headers are an allow-list: content-type, content-length,
  cache-control, etag, last-modified, location (rewritten), content-disposition,
  vary, accept-ranges, content-range, allow, www-authenticate. Dropped
  explicitly: Refresh, Link, Service-Worker-Allowed, Clear-Site-Data,
  Report-To/Reporting-Endpoints/NEL, Permissions-Policy, Origin-Agent-Cluster,
  Access-Control-*, Speculation-Rules, Set-Cookie. The spec does not rely on
  whether the browser would honor these on synthetic responses.
- The document CSP is applied to **every** guest response, not only `text/html`
  (SVG/XHTML/XML with script and sniffed content otherwise run with no policy),
  together with `X-Content-Type-Options: nosniff` and a CSP `sandbox` directive
  so the flags travel with a document opened top-level.
- The SW refuses top-level guest navigations (`mode === "navigate"` with no
  embedding owner frame) instead of serving guest content at top level.
- Ranges: 206 and `Content-Range` pass through so media elements work.
  `Content-Disposition` passes through (`allow-downloads` is set); large
  downloads wait for phase 2 streaming.

### 7. Streaming, SSE, WebSocket (later phases)

- Phase 2: stream responses (SSE, large downloads) with the same abort path.
- Phase 3: WebSockets cannot be intercepted by a SW. Apps build socket URLs from
  `location`, so a bridge-injected, hash-qualified `WebSocket` shim must map
  same-origin prefixed `ws(s)://` URLs to a `MessagePort` relay to
  `dialSandboxPort`. This **is** HTML body rewriting and is an explicit
  exception to section 1; it must run first in the app's realm and cannot cover
  native `WebSocket` captured early or used in workers. Alternatives to weigh in
  that phase's design: SSE/long-poll fallback where an app supports it (Jupyter
  does not) or a separate-origin deployment with a real reverse proxy. The shim
  must not expose any port choice to guest JS.

### 8. Isolating unqualified apps (future, not phase 1)

An opaque-origin iframe (no `allow-same-origin`) is the obvious tool, but
opaque-origin documents are not SW-controlled and, under the parent's COEP
`require-corp` with `CORP: same-origin`, their subresource requests to the
playground origin are blocked; loosening CORP widens exposure. The expected
answer to the spike is "no". The realistic path is a separate origin (second
host or per-session subdomain) with its own SW and COOP/COEP or
`credentialless`. Until that exists, unqualified apps are disabled.

### 9. Naming and migration

Rename `datasette_*` bridge modules to `guest_app_*`, moving the hard-coded
`/apps/datasette/` and port 8001 into the registry. Every site must change
together: `guest_http.ts` `validateGuestPath`, `datasette_protocol.ts`
(`parseGuestRequest`, `parseOwnerMessage`), the `datasette_routes.ts` respond
regex, the SW fetch filter and reserved paths, `datasette_page.ts` (SW URL and
scope), `datasette.ts:87`, `serve.ts:239-251`, the static fallback rule
`/apps/datasette/:session/*` (`tests/build_static_test.ts`),
`public/apps/datasette/service-worker.js`, and the tests.

Service worker migration: widening scope from `/apps/datasette/` to `/apps/`
leaves the old, longer-scope registration winning for `/apps/datasette/*` until
it is unregistered. The page unregisters it, the SW script lives at the reserved
path, and the SW has a version/`skipWaiting` policy for updates while sessions
are live. `tests/datasette_e2e.ts` stays green at every step.

## Phases and acceptance

Phase 1:

- Registry, generic prefix, extracted `ResidentApp`, methods and bodies with the
  limits above, bridge-managed cookie jar, initiator checks, response allow-list
  and CSP on every response, SW migration, listener-ownership check.
  `tests/datasette_e2e.ts` passes unchanged.
- New e2e with a stdlib `wsgiref` guest server: serves HTML and a static asset;
  a POST form with a cookie-backed session and a redirect; editing a served
  guest file shows on refresh; requests appear in the guest log;
  start/stop/reset release the listener; failures surface in the page while the
  terminal stays usable (#168's acceptance items).
- Unit tests for each rule: header allow-lists, Origin/Referer/initiator logic,
  jar parsing and injection, `Location` rewriting, CSP on non-HTML, 413/503,
  top-level navigation refusal, path-escape cases.

Phase 2: streaming. Phase 3: WebSocket shim with its own design. Origin
isolation for unqualified apps: separate design.

## Open questions

1. Registry source of truth: static in the page bundle and pinned with the image
   (this design's default), or an in-guest manifest validated against a static
   allow-list of app ids and ports?
2. Is "cookies are HttpOnly, JS cannot read them" acceptable for the first
   non-Datasette demo apps, or must the demo avoid cookie-reading JS?
