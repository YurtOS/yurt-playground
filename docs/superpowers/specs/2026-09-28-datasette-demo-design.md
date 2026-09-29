# Datasette in the browser sandbox

Status: revised specification reviewed at f9c7ca5 and approved by the user on
2026-09-28. Product implementation follows implementation-plan approval.

## Scope, ownership, and issue dependencies

This is the browser half of
[playground #173](https://github.com/YurtOS/yurt-playground/issues/173):
ordinary upstream Datasette 0.65.5, SQLite, and its existing read-only browser
UI running in the same guest as the terminal and notebook.

[ports #170](https://github.com/YurtOS/yurt-ports/issues/170) blocks completion
of #173. Ports owns system libraries, image composition, and aggregate guest
runtime qualification. It also builds Python packages requiring native code or
compilation, including MarkupSafe and PyYAML, following the Rust `crates/`
producer model. yurt-pypi is the Python package index. Pure Python dependencies
use ordinary hash-locked upstream wheels. The image consumes those Python
artifacts as a complete pinned closure; temporary diagnostic builds do not
replace reusable native package ports. This producer/index ownership follows the
user's clarification on 2026-09-29. Playground exclusively owns the sample
generator, expected results, reset, browser bridge, controls, and acceptance.
The ports image contains the runtime, not a second copy of the sample database.

[#168](https://github.com/YurtOS/yurt-playground/issues/168) is related broader
HTTP-preview work, not a prerequisite that must be completed before #173. This
change first proves its GET/HEAD adapter with a simple guest HTTP server, then
uses it for Datasette. It does not complete #168: request bodies, cookies,
authentication, WebSockets, arbitrary ports/apps, and the general server demo
remain there. #168 should extend the named adapter and protocol types below; a
later mechanism replacement must preserve #173's browser acceptance.

Desktop preview is a follow-up. The Datasette section and Start are hidden when
desktopInfo identifies the native host. Browser features require a qualified
published kernel/image pair, as specified below.

## Verified baseline and new seams

Playground base: 5018bd5; original spec: da3e073. Verified source includes
src/boot.ts, src/executions.ts, src/jupyter.ts, src/coordinator_worker.ts,
src/csp.ts, and the pinned kernel's sandbox_port.ts at a3198c7.

The coordinator owns PlaygroundSession. It already exposes dialSandboxPort,
spawn, process, signal, and readFile. It has no HTTP-request message today.
dialSandboxPort returns only write, read, and close; it is not an HTTP client.

ExecutionRegistry kills finite commands at timeoutMs or its 120-second default,
and permits at most 16 active executions. Its captured output is read after exit
and temporary files are swept five seconds later. It is unsuitable for a
resident server. Existing session.spawn has no deadline, but discards the
process handle and exit promise. Datasette needs the narrow resident-launch seam
described below rather than an assumed existing exit observer.

The browser has no service worker or apps route. Existing site policy prohibits
frames, form submissions, and framing. Network isolation headers are not
automatically attached to a service-worker response.

## Deterministic sample and useful workflow

Playground supplies public/demo/datasette_seed.py. Its command creates
/home/user/demos/datasette/orders.db with the following schema and 12 rows,
inside one committed transaction:

    CREATE TABLE orders (
      id INTEGER PRIMARY KEY,
      ordered_at TEXT NOT NULL,
      product TEXT NOT NULL,
      quantity INTEGER NOT NULL CHECK (quantity > 0),
      unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents >= 0)
    );
    INSERT INTO orders VALUES
      (1, '2026-01-01', 'Notebook', 2, 500),
      (2, '2026-01-01', 'Pen', 5, 100),
      (3, '2026-01-02', 'Mug', 1, 1200),
      (4, '2026-01-02', 'Notebook', 1, 500),
      (5, '2026-01-03', 'Pen', 10, 100),
      (6, '2026-01-03', 'Mug', 2, 1200),
      (7, '2026-01-04', 'Notebook', 3, 500),
      (8, '2026-01-04', 'Pen', 4, 100),
      (9, '2026-01-05', 'Mug', 1, 1200),
      (10, '2026-01-05', 'Notebook', 2, 500),
      (11, '2026-01-06', 'Pen', 1, 100),
      (12, '2026-01-06', 'Mug', 3, 1200);

The sample is synthetic, authored here, and covered by this repo's Apache-2.0
license. Start seeds only when orders.db is absent; it does not overwrite edits.
Reset first confirms server exit, then recreates only demo-owned database,
SQLite sidecar, pid, and log files. It does not remove arbitrary files a visitor
places in the directory. Reset runs the same generator as initial creation.

The suggested query is:

    SELECT product, SUM(quantity * unit_price_cents) AS revenue_cents
    FROM orders
    GROUP BY product
    ORDER BY revenue_cents DESC, product;

Expected rows are Mug/8400, Notebook/4000, Pen/2000. For prefix P defined below,
the query page is P + orders?sql=<URLSearchParams encoding of the query>. CSV is
P + orders.csv?sql=<encoded query>&_dl=1. Its exact UTF-8 body, with CRLF after
every line including the last, is:

    "product,revenue_cents\r\nMug,8400\r\nNotebook,4000\r\nPen,2000\r\n"

JSON is P + orders.json?sql=<encoded query>&_shape=array. Its exact body is the
following single line, with no trailing newline:

    [{"product": "Mug", "revenue_cents": 8400}, {"product": "Notebook", "revenue_cents": 4000}, {"product": "Pen", "revenue_cents": 2000}]

The browser checks both the CSV bytes and the parsed JSON against these values.
JSON is saved through the demo's Download JSON control using a direct
guest-http-request to the coordinator and a Blob download of that response. An
ordinary fetch from the uncontrolled owner page bypasses the scoped worker. CSV
also exercises Datasette's own attachment response. Sorting, filtering, query
submission, and static scripts remain upstream behavior.

"Read-only" means Datasette's ordinary custom-SQL validation: non-SELECT
statements are rejected. The database itself is opened as a mutable positional
file. Do not use --immutable, --crossdb, writable canned queries, --root,
authentication, custom plugins, or an external asset source.

Demonstrate a second writer using guest terminal Python:

    import sqlite3
    with sqlite3.connect("/home/user/demos/datasette/orders.db") as db:
        db.execute(
            "INSERT INTO orders VALUES (?, ?, ?, ?, ?)",
            (13, "2026-01-07", "Pen", 10, 100),
        )

After that command commits and closes its connection, refresh the same query
through a new GET. Pen must become 3000 cents and row count 13. No server
restart is needed. Stop/start keeps the change; Reset restores 12 rows and
Pen/2000. Show the path in the UI so a notebook can inspect the same database.
Page reload still creates a fresh ordinary sandbox; Download home exports files.

## Command, port reservation, and readiness

The coordinator creates a random UUID for each server start. Its URL prefix is P
= /apps/datasette/<session>/, including the final slash. It validates the UUID
and shell-quotes P; the guest receives the complete prefixed path, not a path
with P stripped.

After the finite seed command, a resident shell writes its own pid and execs:

    echo $$ > /home/user/demos/datasette/server.pid &&
    exec python3 -m datasette serve /home/user/demos/datasette/orders.db \
      --host 127.0.0.1 --port 8001 \
      --setting base_url '/apps/datasette/<session>/' \
      --setting default_cache_ttl 0 \
      > /home/user/demos/datasette/server.log 2>&1

This is one sh -c line; any setup failure aborts before exec. No --reload,
--open, or --root is passed. Upstream 0.65.5 explicitly runs Uvicorn workers=1.
Leave num_sql_threads at its upstream default of 3. Cache TTL zero ensures the
demonstration's refreshed query reaches the guest after a terminal commit.

Reserve 8001 against Jupyter by making the browser's five ipykernel ports fixed:
shell 49161, iopub 49162, stdin 49163, control 49164, heartbeat 49165. The
browser launch uses --ip=127.0.0.1 and the supported --shell/--iopub/--stdin/
--control/--hb aliases, including restart. A separate browser-only constant
supplies these values. Do not populate the native msg.kernelPorts field, which
selects bootNativePlayground. Refine the launch builder's bind-address decision:
explicit browser ports must not inherit its existing ports-present => 0.0.0.0
inference. Native launch keeps its own ports and bind configuration.

This reserves 8001 against the playground's Jupyter channels, not arbitrary
guest programs. Another listener produces a clear startup error. Do not select a
different port silently or accept an unrelated server as ready.

Readiness is GET P + orders.json?sql=SELECT+1+AS+ready&_shape=array. The final
response must be status 200, JSON content type, and exactly the parsed array
[{"ready": 1}]. A 301/302/307/308 is not readiness; follow at most four
redirects after validating/rebasing each onto P, then require that final result.
Malformed JSON, other statuses, or incorrect content never count as readiness.

Try immediately, then wait one second after each failed attempt, with one
request in flight. The overall startup budget is 240 seconds from resident
launch. Each request gets the lesser of 30 seconds and remaining startup budget.
Process exit races readiness and immediately closes its pending connection.
Budget exhaustion stops the resident process, removes its route, and displays
the reason plus the bounded log tail. Seed/reset have their own finite-command
errors and never consume that startup budget invisibly.

## Resident supervision and bounded logs

Add PlaygroundSession.startResident(line), implemented alongside spawn with the
existing spawnShell helper. It closes stdin and returns {pid, exited,
signalPid}. exited is the original runStartAsync promise, observed once.
signalPid sends the numeric signal to that positive pid only, using a finite
guest kill command. Do not use the existing group-first session.signal for this
resident. Do not add a no-deadline mode to ExecutionRegistry or use its 16 slots
for Datasette. Retain it for finite seeding, reset, and log-tail reads.

The coordinator holds this handle and checks that server.pid matches the
returned pid; pid-file absence is a startup error. The handle is authoritative,
not a stale pid file. An exit/rejection transitions the demo out of running and
invalidates its route. The resident's stdout/stderr remain in server.log,
outside the registry's temporary capture files.

Read the log through a finite guest tail command:

    exec tail -c 8192 /home/user/demos/datasette/server.log

Capture at most 8192 bytes, with a 30-second finite-command timeout. Retain the
tail command's exit status: success with empty bytes means an empty log; failure
means log unavailable, with that diagnostic shown alongside the original startup
error. Decode for display as text, never HTML. Do not use readFile's 4-MiB
prefix and undefined-for-empty behavior as a log tail or an exit signal.

Stop disables new requests, aborts/closes active connections, sends SIGTERM to
the tracked pid, and waits up to 10 seconds for exited. If still running, send
SIGKILL to that same pid and wait five more seconds. If exit is still
unconfirmed, report stuck and disable Start/Reset rather than reusing a live
port or deleting its data. A later observed exit clears that state. Do not
repeatedly signal after the promised bounds or target another guest job.
Successful stop releases the route and removes the pid file; logs/database
remain. Confirm process reaping and port reuse on the actual guest. Defects in
the underlying completion/signalling path belong in their owner.

## Named GET/HEAD adapter and coordinator messages

Implement src/guest_http.ts as a small HTTP/1.1 client over SandboxPortConn. Its
public request method is the literal union "GET" | "HEAD"; it has no request
body, arbitrary port, cookie, or authentication support. The coordinator
supplies the internal fixed port and current session prefix. Reject other
methods in the service worker before contacting the owner, with status 405 and
Allow: GET, HEAD. Reject upgrade requests with a visible error, never a network
fetch.

Define shared message types in src/datasette_protocol.ts:

- Service worker -> page: datasette-http {session, requestId, method, path,
  headers}; datasette-abort {session, requestId}.
- Page -> coordinator: guest-http-request with those request fields;
  guest-http-abort {session, requestId}.
- Coordinator -> page -> worker: guest-http-response {session, requestId,
  status, headers, body: ArrayBuffer}, or guest-http-error {session, requestId,
  code, message}.
- Page/coordinator lifecycle: datasette-start, datasette-stop, datasette-reset
  with requestId; replies include state, session and bounded failure details.

Headers are a list of pairs restricted to Accept, Accept-Language, If-None-Match
and If-Modified-Since. The adapter supplies Host: 127.0.0.1:8001, Connection:
close, and Accept-Encoding: identity. Never forward browser
Cookie/Authorization, hop-by-hop headers, or an Origin provided by another page.
Paths are origin-form, include P, retain the query, and are validated against
the current session. Reject CR/LF, fragments, network-path targets, and
normalized/encoded traversal out of that prefix.

Use one dial per request. write sends the complete bodyless header block;
HTTP/1.1 GET/HEAD need no half-close. read returns any short fragment
successfully. A zero-length read is EOF, not a retry condition. Closing from
timeout/abort causes a pending polling read/write to throw; suppress only that
expected cancellation when the request has already settled. Always close in
finally.

Parse fragmented HTTP/1.1 status and headers. Bound cumulative headers/trailers
to 64 KiB, body to 16 MiB, and the request to 30 seconds. Skip at most eight
non-upgrade informational responses before the final status. Support one valid
Content-Length, chunked framing including trailers, or EOF-delimited bodies.
Reject conflicting/duplicate length, transfer-encoding plus length, malformed
chunks/headers, unsupported encoding, and premature EOF. EOF-delimited bodies
finish at EOF. HEAD, 204 and 304 finish after headers regardless of
representation Content-Length; never wait for a HEAD body. Reject 101/upgrades.

Dechunk in the adapter and strip hop-by-hop headers plus names listed by
Connection. Preserve application status, content type, attachment disposition,
cache validators, and validated redirects. Recompute Content-Length for decoded
ordinary bodies; preserve valid representation lengths for HEAD/304 and send no
body. Nonidentity Content-Encoding and Set-Cookie are unsupported visible errors
in this subset, not silently altered application behavior.

Resolve Location against the guest request URL. Relative locations and absolute
http://127.0.0.1:8001 locations are accepted only when their normalized path
stays within P. Rewrite them to the browser's same-origin P path/query/fragment.
Reject any other origin/port, path escape, or malformed location with 502. This
prevents navigation to the visitor's real loopback. Browser follows ordinary
redirects; only readiness follows them internally.

Request maps key on session plus requestId. Late responses after abort, stop, or
a new session are discarded. Browser Request.signal cancellation flows through
both relays to conn.close. Protocol/framing/size failures become 502, request
deadline 504, missing/stopped owner 503, unsupported methods 405. No bridge
error returns a truncated success or falls back to fetch. All HEAD responses,
including synthesized errors, omit the body.

## Service-worker script, ownership, and restart

Serve the bundled worker at /apps/datasette/service-worker.js and register with
scope /apps/datasette/. Its script directory permits this scope without a
Service-Worker-Allowed expansion. The root owner page is uncontrolled.

The page uses the returned registration, waits for its worker to activate,
creates a MessageChannel, and sends datasette-register {session, prefix, nonce}
plus port2 to registration.active. The worker validates the same-origin root
owner Client from message.source, records its Client.id with session/P and the
port, and sends datasette-registered {session, nonce}. The page waits up to five
seconds for a matching acknowledgement before opening the iframe. Every
HTTP/abort reply must match the bound port, session, and request id. Another
session cannot replace that owner entry. Stop sends datasette-unregister.

MessagePort closure and controllerchange are not reliable worker-death signals
for this uncontrolled page. Before explicit preview navigation/start, the page
pings the active registration with session/nonce and waits up to two seconds; a
missing acknowledgement triggers a fresh channel/registration handshake. Observe
registration.updatefound and worker state changes to retry activation.

Ordinary iframe navigation may wake a restarted worker before a page ping. If
its in-memory route is missing, the FetchEvent uses clients.matchAll({type:
"window", includeUncontrolled: true}), restricted to same-origin root owner
pages, and sends datasette-find-owner {session, nonce}. Only the live page
holding that session responds by re-registering a fresh port. Wait at most five
seconds, within the request deadline. Require exactly one matching owner and
validate its source Client.id; never pick the first tab. Multiple claims are an
ownership error. The worker uses event.waitUntil for registration/recovery and
respondWith for the request lifetime.

The page retains its current session and handles recovery messages independently
of the old MessagePort. Owner closure or failed recovery yields a 503 document.
It neither boots another sandbox nor restores guest state. A worker restart
recovers the route only; the resident process stays owned by the coordinator.
Test two owners, worker termination/reactivation, and owner disappearance.

## Response policy and static fallback

The service worker constructs every guest HTML and bridge error document with
these headers itself:

    Cross-Origin-Opener-Policy: same-origin
    Cross-Origin-Embedder-Policy: require-corp
    Cross-Origin-Resource-Policy: same-origin

It removes guest CSP/X-Frame-Options and emits exactly one guest-document CSP:

    default-src 'self'; script-src 'self' <qualified sha256 hashes>;
    style-src 'self' 'unsafe-inline'; img-src 'self' data:;
    font-src 'self'; connect-src 'self'; worker-src 'none';
    frame-src 'none'; object-src 'none'; base-uri 'none';
    form-action 'self'; frame-ancestors 'self'

The rendered inline-script hash set comes from pinned 0.65.5 qualification:
_close_open_menus.html, _codemirror_foot.html, and both exact rendered
DATASETTE_ALLOW_FACET = true/false script bodies. Hash the body bytes including
whitespace, not template filenames or unrendered placeholders. Record the set
with the qualified release. Assert all inline bodies encountered on the accepted
UI pages belong to that set. CodeMirror and table.js remain upstream same-origin
assets under P + -/static/. Unknown bodies require qualification, not
unsafe-inline. Error documents contain no inline script.

Send the three isolation headers on synthesized assets/JSON/CSV too; apply
document CSP to document/error responses. Build a fresh Headers object to avoid
duplicate/intersecting policies. Do not copy the strict site CSP and append
another policy. The owner document's single policy changes frame-src to 'self'
for this feature; its form-action and frame-ancestors remain 'none'. Guest
form-action 'self' permits methods at the CSP layer: GET/HEAD enforcement is the
worker/adapter's responsibility.

The local server handles /apps/datasette/ preview URLs before generic fallback.
The Cloudflare Pages build publishes /apps/datasette/unavailable.html and
rewrites /apps/datasette/:session/* to that document when no worker intercepts
the navigation using this _redirects entry:

    /apps/datasette/:session/* /apps/datasette/unavailable.html 200

The worker script is a real single-segment static file and must not match that
session-plus-subpath fallback. Verify the redirect rules against built output.
The fallback is a network document with the strict site CSP and existing
isolation headers; it explains that the owning playground tab must start the
demo. It is not the home page and does not boot a sandbox.

Synthetic guest/error responses get their policy from the worker, not Cloudflare
_headers. Network script/fallback responses get their policy from serve.ts or
Cloudflare Pages headers. Verify actual headers and iframe loading in a browser.
GitHub Pages cannot set COOP/COEP and is not a deployment target.

The pinned application shares this origin. The iframe, scope, and UUID are
routing controls, not an isolation boundary for arbitrary untrusted apps.
Authentication/cookie isolation remains in #168's future design.

## Ports qualification and published-pin gate

At ports pin fccbd6b, the SQLite recipe uses SQLITE_THREADSAFE=0, SQLITE_WASI=1,
SQLITE_OMIT_LOAD_EXTENSION and the Yurt VFS extra initializer. CPython _sqlite3
linking is conditional on staged libsqlite3.a. The actual image was not opened
during this design review; recipe inspection is not artifact/runtime proof.

Ports #170 must report actual guest sqlite3.sqlite_version,
sqlite3.threadsafety, PRAGMA compile_options, and a file-backed
create/insert/commit/query. Require a thread-capable SQLite build (THREADSAFE=1
or 2, reflected by threadsafety > 0) and qualify overlapping Datasette requests
with its default three SQL threads and check_same_thread=False. A passing
serialized query cannot qualify a THREADSAFE=0 build for this concurrent app.
Review WASI/VFS flags in the owning port against Linux behavior and prove
locking/transaction behavior. Qualify imports, assets, exact SQL/exports, clean
process stop, and restart on the published kernel/image pair. Do not set
num_sql_threads=0 to bypass a defect.

Use normal upstream installation/builds for all dependencies, with source
identity, license and hashes, and no host-native guest modules. Keep Datasette
out of the unrelated Jupyter payload lock. The ports-focused agent owns this
qualification. Discovered bugs receive issues in their actual kernel, SDK,
Python, or ports owner with exact artifact IDs and reproduction. Keep those
issues blocking #173/#170 until their fixes pass the original guest probe.

Extend artifacts/pins.json with an optional datasette qualification record:
version 0.65.5, imageSha256, kernelSha256, portsRev, and inlineScriptHashes.
Ports publishes the qualified artifact first. The matching record and image pin
are proposed together only after that guest qualification; browser CI consumes
the proposed record. Neither the record nor pin is published on main or deployed
until exact-head playground browser CI passes. parsePins validates the record
against the active image and kernel digests and ports revision. Absence or
mismatch keeps the feature hidden; there is no runtime guess based on a
successful import or a capability bit. The current pin gets no such record
because it is not qualified.

Qualification runs before the pin update is proposed/published. The record and
new image pin move in the same reviewed change; exact-head browser CI must pass
before deployment. The in-browser page exposes Start only with this matching
record and a non-native host. Start then has the usual startup error handling.
Measure image growth, readiness time, and memory use. Follow existing integrity,
artifact-part, and Cloudflare Pages size limits.

## Alternatives and risks

Waiting for all of #168 first delays a concrete upstream consumer and adds
unused POST/auth/WebSocket scope. The chosen adapter proves simple-server
GET/HEAD behavior first and leaves #168 explicitly open. A srcdoc iframe would
need HTML/link/form/static-script URL rewriting and would alter upstream
behavior. A parent-script fetch proxy cannot intercept ordinary iframe
navigation or GET form submissions. A scoped service worker preserves those
browser operations with the existing guest socket seam.

| Risk                                                   | Owner and resolution                                    | Acceptance blocked until                                                     |
| ------------------------------------------------------ | ------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Resident killed by registry deadline                   | Playground: dedicated resident handle/exit observation  | Session stays alive beyond 120 seconds; stop/reap/port reuse work            |
| THREADSAFE=0 and WASI/VFS assumptions                  | Ports #170; owning kernel/SDK issues for proved defects | Actual thread-capable guest passes overlapping default-threaded queries      |
| Fixed ports accidentally select native bind/boot       | Playground launch builder/coordinator                   | Browser uses 127.0.0.1 and reserved channel ports on initial start/restart   |
| base_url missing trailing slash or bridge stripping it | Playground launcher/HTTP adapter                        | Root/table/query/assets/redirects preserve P                                 |
| COEP/CSP missing on synthesized responses              | Playground worker and policy                            | Real iframe navigation/forms/scripts pass with the exact single policy       |
| Worker restarts while owner is uncontrolled            | Playground ownership handshake                          | Recovery/two-owner tests pass without cross-routing or network fallback      |
| Slow imports or wedged guest exit                      | Playground supervisor; runtime owner if reproduced      | Explicit startup/shutdown bounds and visible log tails; no false ready/reset |
| Stale/unqualified image pin or native host             | Playground pins/visibility; ports publication           | Exact qualified pair gates Start; desktop controls hidden                    |

## Verification and review gates

- Guest qualification in ports #170, including exact identities, thread mode,
  overlapping requests, and a clean resident stop/restart.
- Adapter fixtures: fragmented/short reads, EOF, chunking/trailers, conflicting
  framing, HEAD/bodyless replies, compression rejection, abort/timeout/close,
  header/body bounds, redirects, and rejected POST/upgrade requests.
- Simple Python server before Datasette: HTML + an asset, edit then refresh, log
  evidence, stop/restart, and failed routes never reaching the network.
- Ownership: two page owners, correct request/abort routing, worker restart,
  missing owner, late messages, and direct navigation before installation.
- Browser with real kernel/image: table/sort/filter, GET SQL form, vendored
  scripts under the computed CSP, exact CSV bytes and JSON values, terminal
  commit then refreshed query, non-SELECT rejection with unchanged rows.
- Resident remains running beyond the registry's 120-second default, uses no
  registry slot, preserves edited data across stop/start, resets to the exact
  12-row seed, releases/reaps its process and port, and leaves terminal/notebook
  usable. Read log tail while startup is still running.
- Actual synthesized and network response headers in the local server and built
  Cloudflare Pages routing; feature gating for unqualified/native hosts.
- External requests blocked after artifact loading. Report any supported-browser
  service-worker gaps rather than substituting native-server evidence.
- Format, lint, type, unit/integration, real browser gates, and hosted CI for
  the exact proposed head. Local or host-native success alone is insufficient.

## Review disposition and references

All ten review items are addressed by the contracts above: resident supervision;
command/ports/readiness; byte-stream HTTP/messages; worker handshake/response
policy; exact mutable sample/results; ports blocker/seed ownership; #168/#173
scope; alternatives/risks; qualified-pin/native visibility; Cloudflare naming.
These are revised design decisions, not claims of implemented or passing code.

- https://github.com/simonw/datasette/blob/0.65.5/datasette/cli.py
- https://github.com/simonw/datasette/blob/0.65.5/datasette/renderer.py
- https://github.com/simonw/datasette/blob/0.65.5/datasette/views/base.py
- https://github.com/simonw/datasette/blob/0.65.5/datasette/views/database.py
- https://github.com/ipython/ipykernel/blob/v7.2.0/ipykernel/kernelapp.py
- https://developers.cloudflare.com/pages/configuration/redirects/
- https://github.com/YurtOS/yurt-ports/issues/170
- https://github.com/YurtOS/yurt-playground/issues/173
- https://github.com/YurtOS/yurt-playground/issues/168
