# Guest HTTP preview: generic "Yurtify" for web apps

Status: draft, revised after six design reviews on PR #185. Issue:
[#168](https://github.com/YurtOS/yurt-playground/issues/168). Builds on the
scoped service-worker bridge from #173 (draft PR #176), which already serves
unmodified upstream Datasette from the guest.

## Goal and scope

Run an ordinary web application that listens on `127.0.0.1:<port>` inside the
guest and use it from the browser tab without patching its code. The bridge maps
a browser-visible path to that guest port; the app only needs the base-path
configuration it already supports.

Scope is deliberately two apps: Datasette (exists) and a stdlib `wsgiref`
preview app (the #168 demo). Streaming, WebSockets, origin isolation for
unqualified apps and any larger registry are separate designs, written when a
real consumer needs them. Non-goals: hosted servers, host OS TCP, guest egress,
a general reverse proxy.

## What exists (verified against #176)

- `dialSandboxPort` gives the page a raw byte stream to a guest listener. The
  port comes from coordinator state (`session.guestPorts.datasette`), never from
  message content.
- `src/guest_http.ts`: bounded HTTP/1.1 client. GET/HEAD only, allow-listed
  request headers, 16 MiB body limit, path validation pinned to
  `/apps/datasette/<uuid>/` and port 8001. It does **not** follow redirects: 3xx
  pass through with `Location` rewritten, and a `Location` outside the prefix or
  guest origin is a 502. (The 4-redirect loop is in the Datasette readiness
  probe.) Any guest `Set-Cookie`, in headers or trailers, is currently a 502.
- `src/datasette_service_worker.ts` + `datasette_routes.ts`: the SW intercepts
  `/apps/datasette/<uuid>/**` and relays to the owning tab over a `MessagePort`;
  owner binding, nonce recovery, heartbeats.
- `src/datasette_policy.ts`: strips guest CSP and X-Frame-Options, adds
  COOP/COEP/CORP, and applies `script-src 'self' <hashes>` **only to
  `text/html`**. `'self'` is the playground origin, so any `.js` the guest
  serves also runs. The hashes come from `artifacts/pins.json`
  (`pins.datasette.inlineScriptHashes`) through the coordinator's
  `datasette-qualification` message. The iframe is
  `sandbox="allow-scripts allow-same-origin allow-forms allow-downloads"`.
- `src/datasette.ts`: resident-process supervisor (seed, spawn, readiness, stop,
  reset); Datasette-specific only in its commands and probe.

## Security model (read first)

Guest code can come from untrusted packages. With `allow-same-origin` and
`script-src 'self'`, a guest-served script reaches `window.parent`, the
coordinator, `window.yurt`, other apps' frames (same origin) and all origin
storage. That is acceptable only for a **qualified** app: a pinned, audited
package whose static assets are known (Datasette today), or content the user
authored in their own session (the `wsgiref` preview app), which gets the same
trust as the user's own terminal. Arbitrary or unqualified apps stay disabled;
making them safe needs a separate origin and its own design.

**Inline scripts.** The document policy permits inline scripts only by hash.
Each qualified app's registry entry carries its own static `inlineScriptHashes`
(today's single `pins.datasette` list, generalized to a per-app list pinned with
the image). Consequence, stated up front: apps whose pages have per-request
inline scripts (a CSRF token or nonce inside a `<script>`) cannot be supported,
and apps with static inline scripts (Django admin, Flask templates) work only
after their hashes are listed. The `wsgiref` demo serves no inline script.

## Design

### 1. Addressing: `/apps/<app>/<session>/`

Path-prefix mount on the playground origin (a virtual origin per app needs
wildcard DNS and breaks COOP/COEP). `<app>` is a registry id; `<session>` is a
per-start UUID, so owner state and the cookie jar die with the process. The SW
script is served directly at `/apps/bridge-sw.js` (a script's maximum scope is
its own directory, so no `Service-Worker-Allowed` is needed) and the unavailable
page at `/apps/_bridge/unavailable.html`; `bridge-sw.js` and `_bridge` are
reserved and cannot be app ids, and the `/apps/:app/:session/*` static fallback
excludes them.

The app must produce prefixed URLs itself. Mechanisms the design relies on are
only those verified by the phase 1 e2e: Datasette `base_url`, and for
`wsgiref`/WSGI a small wrapper that sets `SCRIPT_NAME` to the prefix. Django
`FORCE_SCRIPT_NAME` and Jupyter `base_url` are expected to work the same way but
are not claimed until tested. Flask `APPLICATION_ROOT` and uvicorn `--root-path`
are **not** sufficient (Flask only reads `APPLICATION_ROOT` outside a request;
in a request it uses `SCRIPT_NAME`). Apps emitting root-absolute URLs fail:
section 4 turns their redirects into a 502 and body links cannot be rewritten
(no body rewriting, no strip-prefix mode). `Host` is `127.0.0.1:<port>`.

### 2. Registry and supervisor

A static record per qualified app in the page bundle, pinned with the image:
`id`, guest `port`, readiness predicate, `inlineScriptHashes`. The port lives
only in coordinator state, never in page or SW messages (`BROWSER_GUEST_PORTS`
in `boot.ts` becomes a map over the registry). A shared supervisor extracted
from `DatasetteDemo` owns spawn, readiness, stop-releases-listener and reset;
each app supplies its commands. Apps are independent: one tab may run both, with
no new per-app limits beyond the caps in section 3.

Transport scope: phase 1 is **browser tab only**. Only the browser session has
`guestPorts`; the desktop host's `GET /ws/port/<n>` accepts only the five kernel
ports (404 otherwise) and retries a refused connect for 3 s, so a clean refusal
check is not possible there. Desktop support needs a host change and is a
separate item.

Port ownership: before spawning, the coordinator dials the port. Connect
succeeded means busy: refuse to start. `rc=-111` (ECONNREFUSED, thrown by
`connectSandboxPort`) means free. Any other error fails the start. The spawned
process must then stay alive through readiness, so an `EADDRINUSE` exit fails
the start instead of the bridge serving someone else's listener. Remaining races
(a bind between pre-check and spawn; a full backlog, also ECONNREFUSED) are
caught by the survive-readiness rule plus a readiness response only the
qualified app produces.

### 3. Methods, bodies, caps and the request check

Allow `GET HEAD POST PUT PATCH DELETE OPTIONS`. The SW reads the body with
`await request.blob()` (portable; Firefox does not expose `Request.body`, and
`Content-Length` is a forbidden header the SW cannot see), answers 413 when
`blob.size` exceeds 16 MiB (this bounds what is forwarded, not SW memory, which
holds the blob first), then `arrayBuffer()`, transferred SW -> owner ->
coordinator without copies. The client sends an explicit `Content-Length`;
browser-chunked bodies are buffered, never forwarded chunked.

Limits (starting values, tunable by measurement): at most 8 in-flight requests
per session and 16 globally (excess gets 503); at most 64 MiB of buffered
request plus response bytes per session (excess gets 503); cookie jar at most 50
cookies per `(app, session)`, 4 KiB per cookie, 64 KiB total. The 413/503 unit
tests use these numbers.

Request header allow-list: accept, accept-language, if-none-match,
if-modified-since, range, if-range, content-type, x-requested-with,
authorization. `Cookie` is not allow-listed (forbidden for the SW; the
coordinator injects the jar, section 5). Dropped: hop-by-hop headers, `Upgrade`,
`Expect`, proxy headers, anything else.

**Cross-site check.** For unsafe methods (anything but GET/HEAD/OPTIONS) the SW
requires `new URL(request.referrer).origin` to equal the playground origin and
answers 403 otherwise, including an empty or stripped referrer. This stops other
sites from driving an app through the playground URL (the session UUID is secret
only from other origins). It is a cross-site check only: any same-origin
document can still reach any app (Security model). Consequence: an app that sets
`Referrer-Policy: no-referrer` (or any policy that strips the origin) cannot
POST; its safe requests are unaffected.

**Origin/Referer toward the guest** are synthesized as a browser on the app's
own page would send them: none on safe methods; on unsafe methods `Origin` =
`http://127.0.0.1:<port>` and, when the request's referrer is under the app's
prefix, `Referer` = that referrer mapped to the guest URL (otherwise omitted),
so the app's CSRF/Host checks behave as on Linux and
`redirect(request.referrer)` goes back to the page the user was on.

Every request to an app's prefix, from the SW or directly from the owner page,
gets that app's jar cookies. There is no per-initiator gating among same-origin
documents: it cannot be done reliably in a SW (`clientId` is empty for
navigations), same-origin scripts can bypass it, and qualified apps are trusted.
Isolation between apps comes with a separate-origin design.

### 4. Redirects

3xx pass through. `Location` handling is explicit: an absolute URL on the guest
origin whose path is inside the prefix, or a path inside the prefix, is mapped
to the browser-visible prefix; a root-absolute path **outside** the prefix is an
escape and stays a 502 (it would otherwise double-prefix). The browser follows
and replays POST/redirect/GET.

### 5. Cookies: bridge-managed jar

Browsers cannot do this for us: `Set-Cookie` is a forbidden response header name
and a synthetic SW response never feeds the cookie store, and `Cookie` is a
forbidden request header attached after the SW. So:

- A jar keyed by `(app, session)` lives in the **coordinator**, next to
  `requestGuestHttp`, the only code that sees raw `Set-Cookie`. `guest_http.ts`
  changes from "fail on `Set-Cookie`" to "parse into the jar and strip"; trailer
  `Set-Cookie` is dropped; `Domain` is ignored (host-only for 127.0.0.1). RFC
  6265 Path and Max-Age/Expires apply, within the bounds in section 3. The jar
  is cleared on stop/reset.
- `Set-Cookie` is stripped from what reaches the browser. Cookies are
  effectively HttpOnly: `document.cookie` never sees them. `Secure` is satisfied
  (plain http to 127.0.0.1 inside the sandbox); cookies are scoped by app prefix
  and `SameSite` is ignored.
- Consequence: apps whose JavaScript reads a cookie break (e.g. Django AJAX
  reading `csrftoken` into `X-CSRFToken`). Form-field CSRF (Django forms,
  Datasette `asgi-csrf`) works.

### 6. Response policy (defense in depth, qualified apps)

- Response headers are an allow-list: content-type, content-length,
  content-language, cache-control, etag, last-modified, location (rewritten),
  content-disposition, vary, accept-ranges, content-range, allow,
  www-authenticate. Dropped explicitly: Refresh, Link, Service-Worker-Allowed,
  Clear-Site-Data, Report-To/Reporting-Endpoints/NEL, Permissions-Policy,
  Origin-Agent-Cluster, Access-Control-*, Speculation-Rules, Set-Cookie. The
  spec does not rely on whether the browser would honor these on synthetic
  responses. Dropped headers are logged for debugging.
- The document CSP (with the app's `inlineScriptHashes`) is applied to **every**
  guest response, not only `text/html` (SVG/XHTML/XML with script and sniffed
  content otherwise run with no policy), with `X-Content-Type-Options: nosniff`
  and a CSP
  `sandbox allow-scripts allow-same-origin allow-forms
  allow-downloads`
  (exactly the iframe's flags; without `allow-same-origin` the document would
  turn opaque and leave SW control). Its value is limited: it keeps a document
  that reaches top level from gaining top-level-only capabilities.
- The SW refuses top-level guest navigations
  (`request.destination ===
  "document"`; the app frame's own navigations are
  `"iframe"`). Consequence: middle-click, `target=_blank`, `window.open` and
  "open in new tab" on export links are refused; the SW serves an explanatory
  page instead of a bare error.
- Ranges: 206 and `Content-Range` pass through so small media elements work;
  large media fails until bodies can stream (a later design) because responses
  are buffered (16 MiB). `Content-Disposition` passes through (`allow-downloads`
  is set).

### 7. Later designs (not this one)

Response streaming (SSE, large downloads), WebSocket support (a SW cannot
intercept WebSockets; any solution rewrites HTML or needs a separate origin) and
origin isolation for unqualified apps (opaque-origin frames are not
SW-controlled and conflict with COEP/CORP; the realistic path is a separate
origin) each get their own design when a consumer needs them. Nothing here
depends on them.

### 8. Migration

Phase 1 parametrizes the Datasette-specific constants by app id and port and
adds the pieces above; it does **not** rename the `datasette_*` modules (a
rename for a second consumer is churn; rename when a third appears). The
following sites carry `/apps/datasette/`, port 8001 or the single
`pins.datasette` record and must change together:

- `src/guest_http.ts` (`validateGuestPath`), `src/datasette_protocol.ts`
  (`parseGuestRequest`, `parseOwnerMessage`), `src/datasette_routes.ts` (respond
  regex), `src/datasette_service_worker.ts` (fetch filter, reserved paths),
  `src/datasette_page.ts` (SW URL and scope), `src/datasette.ts:87`.
- `src/boot.ts:73,76` (`guestPorts: Readonly<{datasette:number}>`,
  `BROWSER_GUEST_PORTS = { datasette: 8001 }`), `src/pins.ts` and
  `src/coordinator_worker.ts` (the `pins.datasette` qualification and the
  `datasette-qualification` message become per-app).
- `src/serve.ts:238-256`; `scripts/build-static.ts:43-44` (copies the SW and
  `unavailable.html`) and `:150` (the generated `_redirects` rule for
  `/apps/datasette/:session/*`); `scripts/serve.ts:68-73` (bundles the SW into
  `public/apps/datasette/`).
- The generated bundle: `public/apps/datasette/service-worker.js` is gitignored
  (`.gitignore:50`) and excluded from fmt, lint and check
  (`deno.json:27,49,77`); moving it to `public/apps/bridge-sw.js` needs the
  ignore and all three exclusions updated, or CI fails on the generated file or
  it gets committed. Also the built `boot.bundle.js` and
  `coordinator.bundle.js`.
- Tests that hard-code the path or port: `tests/datasette_test.ts`,
  `datasette_fallback_test.ts`, `datasette_routes_test.ts`,
  `datasette_protocol_test.ts`, `guest_http_test.ts`, `build_static_test.ts`,
  `csp_test.ts`, `datasette_bridge_e2e.ts`, `guest_http_e2e.ts`,
  `fixtures/guest_http_worker.ts`.

Service worker migration: widening scope from `/apps/datasette/` to `/apps/`
leaves the old, longer-scope registration winning for `/apps/datasette/*` until
it is unregistered. The page unregisters it, the SW script lives at the reserved
path, and the SW has a version/`skipWaiting` policy for updates while sessions
are live. `tests/datasette_e2e.ts` stays green at every step, and a migration
test upgrades a profile that already has a `/apps/datasette/` registration (the
e2e tests use fresh profiles and never exercise the unregister path).

## Phase 1 acceptance

- `tests/datasette_e2e.ts` passes unchanged.
- New e2e with a stdlib `wsgiref` guest server (behind the `SCRIPT_NAME`
  wrapper): serves HTML and a static asset (including `.mjs` and `.wasm`, to
  prove `nosniff` does not break the guest's own MIME table); a POST form with a
  cookie-backed session and a redirect; editing a served guest file shows on
  refresh; requests appear in the guest log; start/stop/reset release the
  listener; failures surface in the page while the terminal stays usable (#168's
  acceptance items).
- Unit tests for each rule: header allow-lists, Origin/Referer synthesis, the
  cross-site referrer check (cross-site, empty and same-origin referrers), jar
  parsing, injection and bounds, `Location` rewriting, CSP on non-HTML, 413/503
  with the numbers above, top-level navigation refusal, path-escape cases.

## Known limits (stated, not hidden)

- Cookies are HttpOnly to the page: JS-read cookies break (section 5).
- Apps that set `Referrer-Policy: no-referrer` (or strip the origin) cannot POST
  (section 3).
- Apps that build absolute URLs into bodies (JSON `next_url`, Flask `_external`,
  Django `build_absolute_uri`) emit `http://127.0.0.1:<port>/...` links, which
  point at the user's real localhost, not the sandbox. `Location` headers are
  rewritten; bodies are not. Configure the app's external URL or use relative
  URLs (Datasette with `base_url` does).
- Apps with per-request inline scripts are unsupported; static inline scripts
  need their hashes listed (Security model).
- Basic-auth apps likely do not work: a synthetic 401 with `WWW-Authenticate`
  probably does not trigger the browser's credential prompt (verify in the first
  implementation task, then document).
- Large media and downloads are bounded by the 16 MiB buffer.
- Co-hosted qualified apps can reach each other (Security model); isolation
  needs a separate-origin design.

## Open questions

1. Is the registry static in the page bundle and pinned with the image (this
   design's default), or should a guest manifest be allowed, validated against a
   static allow-list of app ids and ports?
2. Is "cookies are invisible to page JavaScript" acceptable for the first
   non-Datasette demo apps, or must the demo avoid cookie-reading JS?
