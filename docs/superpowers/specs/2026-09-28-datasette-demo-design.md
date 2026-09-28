# Datasette in the browser sandbox

Status: proposed specification; design direction approved in chat on 2026-09-28.
Implementation starts after specification and implementation-plan review.

Tracking:
[playground #173](https://github.com/YurtOS/yurt-playground/issues/173). HTTP
preview prerequisite:
[#168](https://github.com/YurtOS/yurt-playground/issues/168).

## Outcome

A visitor starts Datasette in the existing browser sandbox, browses a small
SQLite database in Datasette's upstream UI, executes a SQL query, and downloads
JSON or CSV results. The server, Python interpreter, and database execute in the
same Yurt guest as the terminal and notebook. The application works after its
pinned artifacts have loaded without guest egress.

Use upstream Datasette 0.65.5, the latest stable release returned by GitHub on
2026-09-28. Resolve and pin its actual dependency closure during implementation.
Do not derive dependencies from upstream main, whose requirements differ.

## Evidence and existing seams

Inspected playground main at `5018bd5`. `bootPlayground` already exposes
`dialSandboxPort`, guest process spawning, process signals, and guest file
reads. The coordinator owns that session. The browser page already brokers
requests to the coordinator and starts the existing sandbox.

There is no browser HTTP preview route or service worker in this checkout. The
current CSP disallows frames and form submissions. Preview-specific document
policy and static deployment routing therefore belong in this work.

The current Jupyter package lock does not contain Datasette. The CPython port
can build `_sqlite3` when SQLite is staged; that does not establish that the
pinned playground image supports it. Qualify the actual image before building
the UI. Image composition remains owned by yurt-ports.

## User experience

Add a Datasette demo section with Start, Stop, Reset sample data, a status line,
and a preview. Start boots the normal sandbox if necessary, prepares the sample
database, launches one server, and opens the preview only after HTTP readiness.
Repeated Start does not launch additional servers.

Use a deterministic synthetic orders dataset with a few dozen rows, dates,
products, quantities, and prices in integer cents. Include a suggested SQL query
showing revenue by product, with an exact expected result. Store the database
and server log under `/home/user/demos/datasette/`, so the terminal and notebook
can inspect them. Preserve this directory on ordinary server stop/start. Reset
first stops the server, then recreates only demo-owned data.

The visitor can navigate tables, sort/filter, execute read-only SQL, and export
CSV/JSON using upstream Datasette controls. No login, custom plugin, external
asset, or user-upload flow is required for this first demo. Explain that server
restart preserves the database within the session; page reload starts a fresh
ordinary sandbox. Existing Download home remains available for export.

## Browser-to-guest HTTP path

Use a service worker scoped to `/apps/datasette/`. The live owner page registers
it and establishes a message channel with the active registration. Do not
require the root owner page to be controlled by that scoped worker. Wait for
worker activation and complete the owner handshake before preview navigation.

Each running demo receives an unguessable session identifier. Preview URLs are
`/apps/datasette/<session>/...`. Configure Datasette's supported `base_url` to
that prefix, preserving links, assets, SQL query strings, and local redirects.
The service worker routes requests to the registered owner page, which relays
them to its coordinator. The coordinator makes an HTTP request through
`session.dialSandboxPort` to the demo's fixed guest listening port.

Match the session identifier and owner client for every request. Never select
the first available playground tab. If the worker restarts, the owner can
register again; a missing owner returns an explanatory unavailable response.
Closing the owner must not boot or attach to another sandbox automatically.

Use one guest connection per request, with `Connection: close` and identity
encoding. Correctly handle content-length, chunked, and close-delimited response
bodies; reject malformed or conflicting framing and close on completion,
failure, timeout, or cancellation. Preserve status, content type, and download
headers. Treat HEAD and bodyless responses correctly. Bound headers to 64 KiB,
responses to 16 MiB, and request lifetime to 30 seconds initially. The sample
exports fit these limits; exceedance produces a visible error, never truncation.

This first bridge supports the GET/HEAD surface exercised by the read-only
Datasette demo. POST/authentication cookies, WebSocket upgrades, arbitrary guest
ports, and arbitrary guest applications remain in #168's broader scope. Do not
claim #168 complete from this subset. Confirm that Datasette's selected UI flow
works without those features before implementation is accepted.

The service worker returns guest responses directly without host HTTP
forwarding. It must never fall back to network fetch for a failed guest route.
Requests outside its demo scope retain ordinary site behavior. The dev server
and Pages build provide an explicit unavailable/bootstrap response for direct
preview navigation before a worker exists, rather than silently serving the home
page.

## Document policy

Permit the intended same-origin preview in the owner document and permit
same-origin framing and GET forms in the guest document policy. Keep these
allowances scoped to the demo. Apply COOP/COEP/CORP as required by the existing
isolated owner and verify them in a real browser. Preserve the site's
restriction on external application traffic. Hash any upstream inline script
content needed by the pinned application rather than introducing a global script
allowance.

This is a trusted, pinned upstream application sharing the site's origin; do not
present the iframe or path prefix as a security boundary for arbitrary apps.
Authentication and cookie isolation require their own design before later
multi-application demos use this path.

## Packaging and repository ownership

Use normal upstream package builds/installation for the selected Datasette
release and its dependencies. Package guest Python modules and native extensions
through the existing ports/Python packaging ownership; never stage host-native
extension binaries into the guest or silently remove required dependencies.

The ports change supplies Datasette and its dependencies in a qualified image.
The playground change consumes a pinned released image, supplies the demo seed
data/launcher and UI, builds the service worker, and adds browser acceptance. Do
not add Datasette to the unrelated Jupyter payload lock. Kernel or SDK defects
discovered by ordinary imports, SQLite threading, or socket use are repaired in
their owning repositories. Do not disable upstream threading to hide a runtime
compatibility failure.

The user explicitly requires delegation of missing ports and repairs in the
owning repository. A ports-focused agent owns dependency/image qualification.
For each reproduced cross-repository defect, create an issue with the failing
command, exact artifact identity, expected upstream behavior, and observed
result. Track it as a blocking dependency of #173, repair it in its owner, and
rerun the original probe before clearing the blocker. A compatibility workaround
in the playground cannot substitute for that repair.

Measure image-size increase, server readiness time, and memory use. Follow the
existing artifact integrity and Cloudflare file-part conventions. Only expose
Start with an image that actually contains the qualified application.

## Lifecycle and failure behavior

Track the guest server through the existing execution registry and use `exec`
when launching it so the tracked process is the server. Readiness is a
successful guest HTTP response, not a sleep or a log substring. Surface the
server's exit and a bounded log excerpt if startup fails.

Stop closes pending connections, signals the demo process, waits for its exit,
and releases the session route. Reset runs only after stop completes. Neither
operation signals the user's shell, notebook, or unrelated guest jobs. A second
start must successfully reuse the guest port. Reconcile registry/reaping issues
if they prevent this behavior; do not treat a disabled control as cleanup.

## Verification and completion

1. On the actual pinned guest: import sqlite3, create/query/commit a database,
   import Datasette, and run its ordinary HTTP server. Exercise its normal query
   threading and dependency closure.
2. Test the HTTP adapter against fragmented headers/bodies, chunking, HEAD,
   bodyless responses, malformed framing, disconnects, bounds, and cancellation.
3. Test owner/session routing, service-worker restart, unavailable owners, and
   separation between two page owners. Assert failed guest requests never go to
   the external network.
4. Browser acceptance boots the actual kernel/image, opens upstream Datasette,
   navigates a table, runs the known SQL query, downloads and checks CSV/JSON,
   and observes a guest database change from the terminal/notebook.
5. Stop/start retains data, reset restores the deterministic sample, and pending
   navigation during stop fails cleanly. Verify the terminal/notebook still
   work.
6. Run with external requests blocked after artifact loading. Exercise both
   local-server and built-static routing/policy. Include supported-browser
   service-worker checks; report browser-specific gaps explicitly.
7. Run the repository's format, lint, type, unit/integration, and browser gates;
   hosted CI for the exact proposed head must pass before claiming completion.

Local fixtures, import success, or a host-native Datasette instance alone do not
establish the browser demo's acceptance. Desktop-native preview support is a
separate follow-up; this design targets the browser-local sandbox.

## References

- https://github.com/simonw/datasette/releases/tag/0.65.5
- https://docs.datasette.io/en/stable/settings.html#base-url
- https://github.com/YurtOS/yurt-playground/issues/173
- https://github.com/YurtOS/yurt-playground/issues/168
