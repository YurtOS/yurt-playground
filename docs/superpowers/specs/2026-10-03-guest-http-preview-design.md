# Guest HTTP preview: generic "Yurtify" for web apps

Status: draft, revised after three design reviews on PR #185. Issue:
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
per-start UUID, so owner state and the cookie jar die with the process. The SW
script is served directly at `/apps/bridge-sw.js` (a script's maximum scope is
its own directory, so this avoids `Service-Worker-Allowed`), and the unavailable
page at `/apps/_bridge/unavailable.html`. `bridge-sw.js` and `_bridge` are
reserved and cannot be app ids, and the `/apps/:app/:session/*` static fallback
excludes them.

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
never in page or SW messages.

Transport scope: phase 1 is **browser tab only**. Only the browser session has
`guestPorts` (`boot.ts` `BROWSER_GUEST_PORTS`); the desktop host's
`GET /ws/port/<n>` accepts only the five kernel ports (404 otherwise) and
retries a refused connect for 3 s, so a clean refusal check is not possible
there. Desktop support needs a host change and is a separate item.

Port ownership: before spawning, the coordinator dials the port. Connect
succeeded means busy: refuse to start. `rc=-111` (ECONNREFUSED, thrown by
`connectSandboxPort`) means free. Any other error fails the start. The spawned
process must then stay alive through readiness, so an `EADDRINUSE` exit fails
the start instead of the bridge serving someone else's listener. Remaining
races: a server that binds between the pre-check and the spawn, and a full
listener backlog (also ECONNREFUSED); both are caught by the survive-readiness
rule plus a readiness response only the qualified app produces. Datasette is
entry one; a stdlib `wsgiref` preview app is entry two (the #168 demo).

Multiple apps: owner registry keyed by `(app, session)`; one tab may own
several; limits per session and global (apps, in-flight requests); stop and
reset clean up each app's owner, jar and pending requests.

### 3. Methods and request bodies

Allow `GET HEAD POST PUT PATCH DELETE OPTIONS`. The SW reads the body with
`await request.blob()` (portable: Firefox does not expose `Request.body`, and
`Content-Length` is a forbidden header the SW cannot see), answers 413 when
`blob.size` exceeds 16 MiB (this bounds what is forwarded, not SW memory, which
holds the blob first), then `arrayBuffer()`, transferred SW -> owner ->
coordinator without copies. The client sends an explicit `Content-Length`;
browser-chunked bodies are buffered, never forwarded chunked. In-flight requests
are capped (per session, global); excess gets 503. No streaming in phase 1, so
"back-pressure" means that cap plus buffering.

Request header allow-list: accept, accept-language, if-none-match,
if-modified-since, range, if-range, content-type, x-requested-with,
authorization. `Cookie` is not allow-listed: the browser never exposes it to a
SW (forbidden header) and the coordinator injects its own (section 5). Dropped:
hop-by-hop headers, `Upgrade`, `Expect`, proxy headers, anything else.

Cookies and `Origin`/`Referer` (the port never appears in SW messages; the
coordinator builds the guest request from the prefix it already owns): every
request to an app's prefix, whether it arrives through the SW or directly from
the owner page, gets that app's jar cookies. `Origin` and `Referer` are
synthesized exactly as a browser on the app's own page would send them: none on
safe methods (GET/HEAD/OPTIONS); on unsafe methods `Origin` =
`http://127.0.0.1:<port>` and `Referer` = the mapped full guest URL, so the
app's CSRF/Host checks behave as on Linux.

Deliberately **no initiator gating.** An earlier draft classified requests by
initiator (referrer/client URL) to withhold cookies from other apps' frames. It
was dropped: a SW cannot identify the embedding frame for navigations
(`clientId` is empty), any same-origin script can forge a referrer or reach into
the frame, referrer policies (`no-referrer`, `origin`) break it for real apps,
and it left the owner page's direct requests unclassified. Qualified apps are
trusted (Security model); isolation between apps is the job of the
origin-isolation work in section 8, not of a heuristic. Consequence, stated up
front: while two qualified apps run in one tab, one app's frame can cause
requests to the other with the other's cookies. With a single qualified app
(Datasette) this does not arise, and phase 1 limits concurrent qualified apps to
those that are safe to co-host.

### 4. Redirects

Unchanged: 3xx pass through. `Location` handling is explicit: an absolute URL on
the guest origin whose path is inside the prefix, or a path inside the prefix,
is mapped to the browser-visible prefix; a root-absolute path **outside** the
prefix is an escape and stays a 502 (it would otherwise double-prefix). The
browser follows and replays POST/redirect/GET.

### 5. Cookies: bridge-managed jar

Browsers cannot do this for us: `Set-Cookie` is a forbidden response header name
and a synthetic SW response never feeds the cookie store, and `Cookie` is a
forbidden request header attached after the SW. So:

- A jar keyed by `(app, session)` lives in the **coordinator**, next to
  `requestGuestHttp`, the only code that sees raw `Set-Cookie` (the SW is
  terminated when idle and never sees it). `guest_http.ts` changes from "fail on
  `Set-Cookie`" to "parse into the jar and strip", trailer `Set-Cookie` is
  dropped, and `Domain` is ignored (cookies are host-only for 127.0.0.1).
  Parsing follows RFC 6265 (Path, Max-Age/Expires; bounded size and count). The
  jar is injected as `Cookie` per the rules in section 3 and cleared on
  stop/reset.
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
  content-language, cache-control, etag, last-modified, location (rewritten),
  content-disposition, vary, accept-ranges, content-range, allow,
  www-authenticate. Dropped explicitly: Refresh, Link, Service-Worker-Allowed,
  Clear-Site-Data, Report-To/Reporting-Endpoints/NEL, Permissions-Policy,
  Origin-Agent-Cluster, Access-Control-*, Speculation-Rules, Set-Cookie. The
  spec does not rely on whether the browser would honor these on synthetic
  responses. Dropped headers are logged for debugging, and each session has a
  byte budget across in-flight bodies.
- The document CSP is applied to **every** guest response, not only `text/html`
  (SVG/XHTML/XML with script and sniffed content otherwise run with no policy),
  together with `X-Content-Type-Options: nosniff` and a CSP
  `sandbox allow-scripts allow-same-origin allow-forms allow-downloads` (exactly
  the iframe's flags; without `allow-same-origin` the document would turn opaque
  and leave SW control). Its value is limited: it keeps a document that reaches
  top level from gaining top-level-only capabilities.
- The SW refuses top-level guest navigations
  (`request.destination ===
  "document"`; the app frame's own navigations are
  `"iframe"`). Consequence, stated up front: middle-click, `target=_blank`,
  `window.open` and "open in new tab" on export links are refused; the SW serves
  an explanatory page instead of a bare error.
- Ranges: 206 and `Content-Range` pass through so small media elements work;
  large media fails until phase 2 because bodies are buffered (16 MiB).
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
scope), `datasette.ts:87`, `serve.ts:238-256`, the static fallback rule
`/apps/datasette/:session/*` (generated as the `_redirects` rule at
`scripts/build-static.ts:150`, asserted in `tests/build_static_test.ts`),
`scripts/build-static.ts:43-44` (copies the SW and `unavailable.html`),
`scripts/serve.ts:68-73` (bundles the SW into `public/apps/datasette/`),
`public/apps/datasette/service-worker.js`, the built `boot.bundle.js` and
`coordinator.bundle.js`, and the tests (`tests/csp_test.ts`,
`tests/datasette_bridge_e2e.ts`, `tests/guest_http_e2e.ts`,
`tests/fixtures/guest_http_worker.ts`).

Service worker migration: widening scope from `/apps/datasette/` to `/apps/`
leaves the old, longer-scope registration winning for `/apps/datasette/*` until
it is unregistered. The page unregisters it, the SW script lives at the reserved
path, and the SW has a version/`skipWaiting` policy for updates while sessions
are live. `tests/datasette_e2e.ts` stays green at every step, and a migration
test upgrades a profile that already has a `/apps/datasette/` registration (the
e2e tests use fresh profiles and never exercise the unregister path).

## Phases and acceptance

Phase 1:

- Registry, generic prefix, extracted `ResidentApp`, methods and bodies with the
  limits above, bridge-managed cookie jar, response allow-list and CSP on every
  response, SW migration, listener-ownership check. `tests/datasette_e2e.ts`
  passes unchanged.
- New e2e with a stdlib `wsgiref` guest server: serves HTML and a static asset;
  a POST form with a cookie-backed session and a redirect; editing a served
  guest file shows on refresh; requests appear in the guest log;
  start/stop/reset release the listener; failures surface in the page while the
  terminal stays usable (#168's acceptance items).
- Unit tests for each rule: header allow-lists, Origin/Referer synthesis, jar
  parsing and injection, `Location` rewriting, CSP on non-HTML, 413/503,
  top-level navigation refusal, path-escape cases.

Phase 2: streaming. Phase 3: WebSocket shim with its own design. Origin
isolation for unqualified apps: separate design.

## Known limits (stated, not hidden)

- Cookies are HttpOnly to the page: JS-read cookies break (section 5).
- Basic-auth apps likely do not work: a synthetic 401 with `WWW-Authenticate`
  probably does not trigger the browser's credential prompt (verify in the first
  implementation task, then document).
- Large media and downloads are bounded by the 16 MiB buffer until phase 2.

## Open questions

1. Registry source of truth: static in the page bundle and pinned with the image
   (this design's default), or an in-guest manifest validated against a static
   allow-list of app ids and ports?
2. Is "cookies are HttpOnly, JS cannot read them" acceptable for the first
   non-Datasette demo apps, or must the demo avoid cookie-reading JS?
