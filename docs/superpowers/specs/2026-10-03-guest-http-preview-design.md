# Guest HTTP preview: generic "Yurtify" for web apps

Status: draft for review. Issue:
[#168](https://github.com/YurtOS/yurt-playground/issues/168). Builds on the
scoped service-worker bridge from #173 (draft PR #176), which already serves
unmodified upstream Datasette from the guest.

## Goal

Run an ordinary web application that listens on `127.0.0.1:<port>` inside the
guest and use it from the browser tab, without patching the application. The app
keeps believing it is on localhost; the bridge maps a browser-visible virtual
origin path to that guest port. Application changes are limited to configuration
the app already supports (a base path), never code patches.

Non-goals: hosted servers, host OS TCP, guest egress, a general reverse proxy.

## What exists (verified in #176)

- `dialSandboxPort` gives the page a raw byte stream to a guest listener.
- `src/guest_http.ts`: bounded HTTP/1.1 client over that stream. GET/HEAD only,
  allow-listed request headers, redirects followed internally (max 4), body
  buffered up to 16 MiB, path validation pinned to `/apps/datasette/<uuid>/` and
  port 8001.
- `src/datasette_service_worker.ts` + `datasette_routes.ts`: a service worker
  intercepts `/apps/datasette/<uuid>/**` and relays to the owning tab over a
  `MessagePort`; owner binding, nonce recovery, heartbeats.
- `src/datasette_policy.ts`: strips guest CSP and X-Frame-Options, applies a
  per-document CSP that allows only hash-qualified inline scripts, adds
  COOP/COEP/CORP.
- `src/datasette.ts`: resident-process supervisor (seed, spawn, readiness, stop,
  reset) that is Datasette-specific only in its commands and probe.

Most of the bridge is generic in behavior and Datasette-specific in naming,
constants and the 8001/`datasette` assumptions.

## Design

### 1. Addressing: `/apps/<app>/<session>/`

Keep the path-prefix mount (a virtual origin per app would need wildcard DNS and
would break COOP/COEP; one origin keeps the existing isolation story). `<app>`
is a registry id (`datasette`, `preview`, ...); `<session>` stays a per-start
UUID, so cookies and owner state die with the process.

Apps must be prefix-aware via their own configuration (Datasette `base_url`,
Flask `APPLICATION_ROOT`/`SCRIPT_NAME`, Django `FORCE_SCRIPT_NAME`, uvicorn
`--root-path`, Jupyter `base_url`). That covers the apps we care about with no
patches. Prefix-unaware apps: the bridge strips the prefix before forwarding (so
`/apps/x/<s>/a` reaches the guest as `/a`) and rewrites only protocol headers
(section 4, 5). It does not rewrite HTML bodies; apps that emit root-absolute
URLs must be configured. This is the supported limit.

### 2. App registry

A small declarative record per app: `id`, guest `port`, `basePath` mode
(`app-aware` | `strip-prefix`), readiness path/predicate, request policy
(section 3) and document policy (section 6). `DatasetteDemo` keeps its seed and
launch commands but consumes the registry and a shared `ResidentApp` supervisor
extracted from it (spawn, readiness, stop-releases-listener, reset). Datasette
is registry entry one; a stdlib `http.server`/`wsgiref` preview app is entry two
and is the #168 demo.

### 3. Methods and request bodies

Allow `GET HEAD POST PUT PATCH DELETE OPTIONS`. The service worker reads the
request body fully (bounded, 16 MiB, same as responses) and the client sends it
with an explicit `Content-Length`; chunked request bodies from the browser are
buffered, never forwarded chunked. Header allow-list gains `content-type`,
`x-requested-with`, `authorization`, `cookie`, and the existing conditional and
negotiation headers. `Host` is set to `127.0.0.1:<port>`; `Origin` and
`Referer`, when present, are rewritten to `http://127.0.0.1:<port>` so the app's
CSRF/Host checks (Django, Datasette `asgi-csrf`) behave as on Linux. Everything
else, including `Connection`, `Upgrade`, `Transfer-Encoding`, proxy headers, is
dropped as today.

### 4. Redirects

Stop following redirects inside the bridge. Pass 3xx through with `Location`
rewritten: same-guest-origin absolute URLs and root-absolute paths are mapped
under the prefix; anything else is a 502 (as today). The browser then follows
and replays POST/redirect/GET correctly and the cookie jar stays coherent.

### 5. Cookies

The browser jar is per origin and path, and the playground origin is shared with
the page, so `Set-Cookie` is rewritten: `Domain` dropped, `Path` forced to the
app prefix (a request-relative path is re-rooted under it), size bounded,
`Secure` kept (localhost is a secure context). `SameSite` defaults to `Lax` if
absent. The browser then sends only that app's cookies for that session path
automatically, which isolates apps and sessions from each other and from the
page. No cookie storage in JavaScript.

### 6. Origin isolation (the main risk)

Guest code is user-controlled but may come from untrusted packages. Today the
iframe is `sandbox="allow-scripts allow-same-origin ..."` and only
hash-qualified inline scripts run, which works for one qualified app and does
not scale to arbitrary apps. Generalizing needs a policy tier per app:

- `qualified`: current model; inline scripts allowed by hash from the pin.
- `opaque`: iframe without `allow-same-origin` so guest scripts cannot reach
  `window.parent`, `window.yurt` or the service worker. Requires a spike (see
  open questions): whether a service worker still serves navigations and
  subresources for an opaque-origin document.

Unqualified apps default to `opaque` or stay disabled; `unsafe-inline` without
an opaque origin is never offered.

### 7. Streaming, SSE, WebSocket (later phases)

- Phase 2: stream responses (SSE, large downloads) instead of buffering, with
  the same cancellation/abort path.
- Phase 3: WebSockets cannot be intercepted by a service worker. The only way
  that keeps apps unpatched is a bridge-injected `WebSocket` shim (a small,
  hash-qualified script added to HTML responses) that maps
  `ws://127.0.0.1:<port>/...` to a `MessagePort` relay to `dialSandboxPort`.
  That changes the document and needs its own review; it is what Jupyter server
  needs. Out of scope for phase 1.

### 8. Naming and migration

Rename the `datasette_*` bridge modules to `guest_app_*` with the registry
supplying app id and port, keeping behavior and `tests/datasette_e2e.ts`
unchanged and green at every step. Constants (`8001`, `/apps/datasette/`) move
into the registry.

## Phases and acceptance

Phase 1 (this design's implementation):

- Registry, generic prefix, extracted `ResidentApp`, methods + bodies,
  pass-through redirects, cookie rewriting. `tests/datasette_e2e.ts` still
  passes.
- New e2e with a stdlib guest server (no package dependency): serves HTML and a
  static asset; a POST form with a cookie-backed session and a redirect; editing
  a served guest file shows on refresh; requests appear in the guest log;
  start/stop/reset release the listener; failures surface in the page while the
  terminal stays usable. These are #168's acceptance items.
- Unit tests: request/response header policy, Host/Origin/Referer rewriting,
  Set-Cookie rewriting, redirect rewriting, body limits, path-escape cases.

Phase 2/3: streaming; WebSocket shim; opaque-origin tier if the spike says yes.

## Open questions (need a decision or a spike)

1. Does a service worker serve an opaque-origin (sandboxed, no
   `allow-same-origin`) iframe's navigation and subresources? If not, how do
   unqualified apps get isolation (separate origin via a second host, or only
   qualified apps)?
2. Is `strip-prefix` support for prefix-unaware apps worth shipping in phase 1,
   or do we require app-aware configuration only?
3. Registry location: static in the page bundle, or declared by an in-guest
   manifest the bridge validates?
