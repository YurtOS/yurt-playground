# Datasette Demo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development or superpowers:executing-plans to
> implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Run upstream Datasette in the browser's existing Yurt sandbox, with
browsing, SQL, exports, and reliable stop/reset over the same SQLite file that
the terminal and notebook use.

**Architecture:** The coordinator supervises a resident guest process and runs a
bounded GET/HEAD client over guest sockets. A scoped service worker relays
iframe requests through the uncontrolled owner page to that coordinator.
Published qualification of the exact kernel/image pair gates the demo.

**Tech Stack:** Deno 2.7.14, TypeScript, browser service workers and
MessageChannel, Playwright 1.55.0, guest CPython/SQLite, upstream Datasette
0.65.5.

**Spec:** [Datasette design](../specs/2026-09-28-datasette-demo-design.md),
reviewed at f9c7ca5 and approved on 2026-09-28.

## Global Constraints

- Work in `.worktrees/datasette-demo`; keep the primary checkout untouched.
- Datasette 0.65.5; no altered upstream templates, plugins, authentication,
  writable canned queries, `--immutable`, `--crossdb`, `--root`, or `--reload`.
- Guest bind 127.0.0.1:8001; prefix `/apps/datasette/<UUID>/` includes its
  slash.
- Browser Jupyter ports: shell 49161, iopub 49162, stdin 49163, control 49164,
  heartbeat 49165. Native boot selection remains separate.
- Default three SQL threads; no `num_sql_threads=0` workaround.
- HTTP GET/HEAD only, one connection per request, 30-second request limit, 64
  KiB cumulative headers/trailers, 16 MiB body, eight informational responses.
- Readiness: 240 seconds overall, one-second retry delay, at most four validated
  redirects, final 200 JSON `[{'ready': 1}]` with no additional keys or rows.
- Stop: tracked positive pid, TERM then ten seconds, KILL then five seconds;
  unconfirmed exit disables Start/Reset. Log tail: 8192 bytes, 30-second
  command.
- Worker script `/apps/datasette/service-worker.js`, scope `/apps/datasette/`;
  owner root page is uncontrolled. Handshake/recovery five seconds, ping two.
- Ports #170 owns runtime/dependencies/image/qualification; playground owns
  seed. Qualified THREADSAFE=1 or 2, threadsafety > 0, overlapping requests
  required.
- No qualification record on today's unqualified pins. Native demo is hidden.
- Cloudflare Pages deployment; exact-head hosted CI and real guest browser
  acceptance are required before claiming completion. No merge is authorized.
- Fix reproduced bugs in their owning repository, with linked issues and
  original probes; no playground compatibility substitutions.

## Review Focus

1. Stop during slow startup: invalidate the route, cancel the probe, and prevent
   a late readiness response from reviving the server (Task 3).
2. A resident that refuses to exit: retain its identity, prohibit reset/restart,
   and recover only after observing that original exit (Task 3).
3. Worker eviction with two owner tabs: recover exactly one matching session or
   return 503; never route to another sandbox (Task 4).
4. HEAD redirects/errors and fragmented framing: return bodyless responses and
   close the connection without waiting for a representation body (Tasks 1/4).
5. Root-page JSON download: use the coordinator directly, because root fetch
   bypasses this worker; downloaded bytes must match the guest (Task 5).

## File Structure

New production files:

- `src/datasette_protocol.ts`: shared lifecycle/HTTP/ownership messages and
  guards.
- `src/guest_http.ts`: guest HTTP byte-stream client; no page or lifecycle code.
- `src/datasette.ts`: sample commands, readiness, resident state, request
  ownership.
- `src/datasette_policy.ts`: guest response policy and bodyless error responses.
- `src/datasette_routes.ts`: service-worker owner registry and recovery logic.
- `src/datasette_service_worker.ts`: browser event bindings for the route
  registry.
- `src/datasette_page.ts`: controls, page relay, registration and JSON download.
- `public/demo/datasette_seed.py`: deterministic database generator.
- `public/apps/datasette/unavailable.html`: strict network fallback document.

Existing seams to modify: `src/boot.ts`, `src/jupyter.ts`,
`src/coordinator_worker.ts`, `src/page.ts`, `src/pins.ts`, `src/csp.ts`,
`src/serve.ts`, `scripts/serve.ts`, `scripts/build-static.ts`,
`public/index.html`, `public/demo/README.md`, `deno.json` bundle exclusions,
CI/deploy acceptance scenes. Use focused new test files listed below; extend
existing seam tests in place.

## Task 1: Guest HTTP client and shared wire protocol

**Files:** Create `src/guest_http.ts`, `src/datasette_protocol.ts`,
`tests/guest_http_test.ts`, `tests/datasette_protocol_test.ts`.

**Interfaces:**

```ts
export type GuestMethod = "GET" | "HEAD";
export type HeaderPairs = [string, string][];
export interface GuestConnection {
  write(bytes: Uint8Array): Promise<void>;
  read(size: number): Promise<Uint8Array>;
  close(): Promise<void>;
}
export interface GuestHttpReply {
  status: number;
  headers: HeaderPairs;
  body: ArrayBuffer;
}
export interface GuestHttpOptions {
  session: string;
  prefix: string;
  method: GuestMethod;
  path: string;
  headers: HeaderPairs;
  signal: AbortSignal;
  timeoutMs?: number;
}
export function requestGuestHttp(
  dial: () => Promise<GuestConnection>,
  options: GuestHttpOptions,
): Promise<GuestHttpReply>;
```

These signatures match `SandboxPortConn` in the pinned kernel's
`packages/kernel-host-interface-js/kernel-host-interface/sandbox_port.ts`. Its
write method handles partial writes internally. Await asynchronous close in
cleanup, preserving the original request error if close also rejects.

Protocol messages use the design's exact type tags. HTTP requests include
`session`, `requestId`, `method`, `path`, and headers; responses carry status,
headers, and transferable body. Errors carry code/message; lifecycle replies
carry requestId and the Task 3 state. Ownership registration uses session,
prefix, nonce and transferred port. Runtime guards reject malformed values,
invalid UUIDs, CR/LF in paths/headers, and paths outside that session prefix.

- [x] Write wire fixtures with a fake connection that returns each response one
      byte at a time. Include this behavior-discriminating test:

```ts
Deno.test("HEAD does not wait for Content-Length bytes", async () => {
  const wire = new TextEncoder().encode(
    "HTTP/1.1 200 OK\r\nContent-Length: 999\r\n\r\n",
  );
  let reads = 0;
  let closed = false;
  const reply = await requestGuestHttp(async () => ({
    write: async (_bytes) => {},
    read: async () => {
      if (reads++ !== 0) throw new Error("unexpected body read");
      return wire;
    },
    close: async () => {
      closed = true;
    },
  }), {
    session: "11111111-1111-4111-8111-111111111111",
    prefix: "/apps/datasette/11111111-1111-4111-8111-111111111111/",
    path: "/apps/datasette/11111111-1111-4111-8111-111111111111/orders",
    method: "HEAD",
    headers: [],
    signal: new AbortController().signal,
  });
  assertEquals(reply.body.byteLength, 0);
  assertEquals(reads, 1);
  assertEquals(closed, true);
});
```

- [x] Add fixtures for Content-Length, chunks/extensions/trailers, EOF bodies,
      short reads, eight/nine interim replies, 204/304, duplicate/conflicting
      length, TE+length, truncated bodies, bad chunks, 101, Set-Cookie,
      nonidentity encoding, header/body limits and CR/LF injection. Assert the
      request has fixed Host, identity encoding, Connection close, no secrets.
- [x] Add abort-before-dial and abort-during-read tests; late dial completion
      must close its connection. Timeout must close once and reject as 504.
      Relative/guest-loopback redirects inside P are rewritten; foreign origins,
      encoded/normalized prefix escapes and malformed targets fail as 502.
- [x] Run
      `deno test --allow-all tests/guest_http_test.ts tests/datasette_protocol_test.ts`
      and capture the initial failure before implementing.
- [x] Implement incremental parsing with one reader, bounded buffering,
      monotonic remaining deadline and cleanup in `finally`. Strip hop-by-hop
      headers and Connection tokens; retain validated HEAD/304 representation
      lengths and recompute ordinary decoded body length.
- [x] Run the focused tests, formatter, lint and type check. Commit as
      `feat: add bounded guest HTTP client`.

## Task 2: Resident process seam and explicit browser kernel ports

**Files:** Modify `src/boot.ts`, `src/jupyter.ts`, `src/coordinator_worker.ts`;
extend `tests/boot_test.ts`, `tests/jupyter_launch_test.ts`,
`tests/jupyter_test.ts`; add `tests/resident_test.ts`.

**Interfaces:** `PlaygroundSession.startResident(line)` returns the actual pid,
the original process completion promise and `signalPid(signal: number)`. Use the
completion type from `process.runStartAsync`; do not invent exit status or use
output files as exit signals. Add an explicit optional bind-address parameter to
Jupyter launch/start/restart builders, defaulting compatibly for existing
callers. Export `BROWSER_KERNEL_PORTS` from `src/jupyter.ts`.

- [x] Write failing launch assertions that browser initial/restart commands
      contain `--ip=127.0.0.1` and all five reserved ports; native commands
      retain their explicit ports and 0.0.0.0 bind. Assert `msg.kernelPorts`
      continues to select native boot only.

```ts
const command = buildKernelLaunchCommand(
  JUPYTER_CONNECTION_FILE,
  BROWSER_KERNEL_PORTS,
  "127.0.0.1",
);
assertStringIncludes(command, "--ip=127.0.0.1");
for (
  const flag of [
    "--shell=49161",
    "--iopub=49162",
    "--stdin=49163",
    "--control=49164",
    "--hb=49165",
  ]
) assertStringIncludes(command, flag);
```

- [x] Test resident stdin closure, preservation of the original exit promise,
      positive-pid kill command, exit rejection observation and no registry
      allocation. Reuse the repository's existing kernel test harness for an
      actual sleep/exit/signalling test; require artifacts when CI requests it.
- [x] Run those tests red, then implement using `spawnShell`, the existing user
      credentials/home, `runStartAsync`, and a finite numeric `kill` command. Do
      not call the existing group-first signal helper.
- [x] Wire browser ports/bind through initial start and restart without changing
      native dispatch. Run focused tests and commit
      `feat: supervise resident guest processes`.

## Task 3: Deterministic sample and Datasette lifecycle

**Files:** Create `src/datasette.ts`, `public/demo/datasette_seed.py`,
`tests/datasette_test.ts`, `tests/datasette_seed_test.ts`; modify
`src/coordinator_worker.ts` and `public/demo/README.md`.

**Interfaces:**

```ts
export type DatasetteState =
  | "stopped"
  | "starting"
  | "running"
  | "stopping"
  | "failed"
  | "stuck";
export interface DatasetteSnapshot {
  state: DatasetteState;
  session?: string;
  prefix?: string;
  error?: string;
  logTail?: string;
}
// Constructor receives the session, finite execution registry, guest HTTP
// client, injected clock/delays, and a snapshot callback.
// Public methods: start(), stop(), reset(), request(request), abort(session,id).
// start/stop/reset return Promise<DatasetteSnapshot>; request returns
// Promise<GuestHttpReply>. Mutating cleanup operations are serialized.
// stop() invalidates the startup generation and aborts its probe immediately,
// before waiting for serialized cleanup; it never queues behind readiness.
```

The constructor's concrete dependency types reuse Tasks 1/2 and the existing
registry; define them in this file rather than duplicating production classes.
Injected time permits testing the 240/10/5-second bounds without wall-clock
waits.

- [ ] Add the exact DDL/12 rows from the spec to the generator, one transaction.
      Support initial creation without overwriting an existing file and an
      explicit reset invocation after confirmed exit. Delete only orders.db and
      its named SQLite sidecars, server.pid and server.log; preserve other
      files.
- [ ] Publish `demo/datasette_seed.py` through the explicit STATIC_FILES list in
      `scripts/build-static.ts`, and assert its exact bytes in built output.
      Fetch the script once before seed/reset through the coordinator's ordinary
      static fetch (not fetchPlaygroundBytes, which handles only pinned blobs).
      Stage it into `/home/user/demos/datasette/datasette_seed.py` with a finite
      registry command and stdin bytes; then exec it with guest Python.
      Missing/download/staging errors abort Start visibly. The database remains
      guest-owned; no host Python or second seed source supplies it.
- [ ] Write guest seed tests for row count, integer revenue result, commit to
      Pen/3000, repeated initial seed preserving changes, and reset restoring
      Pen/2000 while preserving a sentinel file. Host Python may additionally
      check the authored SQL, but cannot replace guest qualification.
- [ ] Write fake-dependency lifecycle tests before implementation: readiness
      status/type/shape rejection, redirect budget, pid-file mismatch, early
      exit, timeout/log-tail diagnostics, empty vs unavailable log, start
      coalescing, stop during startup, stale readiness after stop/new session,
      TERM/KILL timing, stuck state, later exit recovery, and reset prohibition.
- [ ] While start() is waiting on an unresolved readiness read, invoke stop().
      Assert its probe closes and TERM is delivered before that read resolves or
      the 240-second startup timer expires. Resolve a late successful probe and
      verify the invalidated generation never transitions to running.

```ts
// Required assertions for the injected-clock stuck-resident fixture:
assertEquals(signals, [15, 9]);
assertEquals(snapshot.state, "stuck");
await assertRejects(() => demo.start());
await assertRejects(() => demo.reset());
assertEquals(seedCalls, 0);
// Resolve that same resident's exit promise; await its observer.
assertEquals(latestSnapshot.state, "stopped");
```

- [ ] Run
      `deno test --allow-all tests/datasette_test.ts tests/datasette_seed_test.ts`
      red. Implement the exact launch line, random per-start UUID, mutable file,
      TTL zero, probe and shutdown bounds. Route requests only to the current
      running session; close all pending connections before stop signals.
- [ ] Integrate coordinator message handlers with transferable responses,
      `(session, requestId)` keys and cancellation. Native sessions reject this
      browser-only feature. Log failures preserve the original startup reason.
- [ ] Run focused tests and existing execution/Jupyter regression tests; commit
      `feat: add Datasette seed and resident lifecycle`.

## Task 4: Scoped worker routing, response policy and static fallback

**Files:** Create `src/datasette_routes.ts`, `src/datasette_policy.ts`,
`src/datasette_service_worker.ts`, `public/apps/datasette/unavailable.html`,
`tests/datasette_routes_test.ts`, `tests/datasette_policy_test.ts`,
`tests/datasette_bridge_e2e.ts`; modify `src/serve.ts`, `scripts/serve.ts`,
`scripts/build-static.ts`, `deno.json`, `tests/serve_test.ts`,
`tests/build_static_test.ts`.

**Interfaces:** Route registry exposes registration, unregister, ping and
`respond(request, clientId)`; injectable client lookup/message transports permit
unit tests. Response policy exports `guestResponse(reply, method, hashes)` and
`bridgeErrorResponse(status, message, method, hashes)`. The worker entry binds
install/activate/message/fetch and owns event lifetime promises. It imports only
the protocol, route registry and policy, never kernel/page modules.

- [ ] Write unit tests for exact one CSP, three isolation headers, guest policy
      removal, HTML text escaping, bodyless HEAD errors, 405 Allow, hashes,
      origin/prefix/source identity validation, duplicate claims, expired nonce,
      missing owner, stale responses and abort forwarding.
- [ ] Run tests red, implement the five-second ownership handshake/recovery,
      includeUncontrolled root-owner lookup and exactly-one-claim rule. Keep
      recovery alive with waitUntil; fetch lifetime belongs to respondWith.
      Never perform network fallback for intercepted guest routes.
- [ ] Bundle the worker to the exact URL using the existing Deno bundle pipeline
      in `scripts/serve.ts`; copy it in static build and add generated-file
      exclusions consistent with existing bundles. Publish unavailable.html and
      `_redirects` with the spec's single rule. Local preview routes resolve to
      that same fallback before generic routing; the worker script bypasses it.
- [ ] Extend static/server tests for worker URL, MIME, strict fallback policy,
      isolation headers and redirect rule. Do not append duplicate CSP headers.
- [ ] Write a browser harness with two uncontrolled root owners and mock
      coordinator replies. Assert iframe navigation/form/assets work, POST is
      405, HEAD has no body, stop aborts a pending read, foreign session replies
      are ignored, owner removal gives 503 and root fetch bypasses the worker.
      Use Chromium CDP worker termination to exercise wakeup/re-registration,
      then repeat a navigation with two owner tabs and missing/duplicate claims.
- [ ] Run `deno run --allow-all tests/datasette_bridge_e2e.ts`; capture red
      before wiring the worker and green after. Test actual response headers in
      the browser, not only header builder output. Commit
      `feat: route guest previews through a scoped service worker`.

## Task 5: Qualification gate, controls and downloads

**Files:** Create `src/datasette_page.ts`, `tests/datasette_page_test.ts`,
`tests/datasette_pins_test.ts`; modify `src/pins.ts`, `src/page.ts`,
`src/coordinator_worker.ts`, `src/csp.ts`, `public/index.html`,
`tests/csp_test.ts`, `tests/build_static_test.ts`,
`tests/datasette_bridge_e2e.ts`.

**Interfaces:** Optional `Pins.datasette` has literal version `0.65.5`,
imageSha256, kernelSha256, portsRev and nonempty inlineScriptHashes. Parse and
validate digest/revision identity and SHA-256 CSP hash syntax. Absent/mismatched
qualification provides no capability and keeps controls hidden; malformed
records report a diagnostic without claiming qualification. Export a single
eligibility helper shared by page and coordinator. Mount function receives
container, coordinator messaging and validated qualification; returns dispose.

- [x] Write failing tests for absent, valid, mismatched and malformed records;
      test every identity independently, empty/invalid hash list, wrong version
      and native host. Keep today's artifacts/pins.json without a record.
- [x] Implement validation and visibility, pass validated qualification to the
      coordinator, and reject start messages without eligibility. Mount an
      accessible section with Start, Stop, Reset, query preview, Download JSON,
      status/error/log text and database path. Disable controls by lifecycle;
      stuck forbids Start/Reset. Render logs with textContent.
- [x] Before iframe navigation, activate/ping/handshake using the registration;
      listen for recovery messages independently of the old port. Dispose old
      requests/ports on stop or session replacement. Keep the iframe hidden
      until the ownership acknowledgement arrives.
- [x] Route JSON download directly to coordinator request/reply, make a Blob URL
      from the returned bytes, click a download link and revoke the URL. Add the
      regression browser test below; no owner fetch is involved:

```ts
const downloadPromise = page.waitForEvent("download");
await page.getByRole("button", { name: "Download JSON" }).click();
const download = await downloadPromise;
const file = await download.path();
assert(file !== null);
assertEquals(await Deno.readTextFile(file), expectedGuestJson);
assertEquals(ownerNetworkJsonRequests, 0);
```

- [x] Change only the owner document's single CSP to frame-src self; guest and
      fallback policies retain their different form/framing rules. Run focused
      tests, native visibility and mock bridge browser acceptance. Commit
      `feat: add qualified Datasette controls and exports`.

## Task 6: Prove simple guest server and integrate qualified Datasette

**Files:** Create `tests/guest_http_e2e.ts`, `tests/datasette_e2e.ts`; modify
`.github/workflows/ci.yml`, `.github/workflows/deploy-pages.yml`,
`tests/layout_test.ts` and browser scene selection wherever those files assert
the scene matrix. Only after qualification, update `artifacts/pins.json` and the
corresponding provenance using existing pin/install scripts.

**Interfaces:** Browser drivers use real `window.yurt` commands for guest file
creation/terminal commits and the normal UI for the Datasette workflow. The
simple-server scene exercises the adapter before an app-qualified record exists;
its harness uses `tests/fixtures/guest_http_worker.ts`, a test-only worker entry
that imports bootPlayground, the resident seam and requestGuestHttp. A test-only
page relays that worker's requests through the production scoped service worker.
The harness exposes start-resident, signal-resident, HTTP and finite commands
only inside the test server; it is neither copied to dist nor imported by the
production coordinator. The normal production eligibility gate stays enforced.

- [ ] First write and run the real simple-server scene: start Python HTTP server
      at the reserved loopback port via the resident seam, serve HTML and an
      asset, edit in guest then refresh, verify logs while live, stop, confirm
      exit and port reuse, restart. Failed/aborted requests must never hit host
      network. Establish this baseline before testing Datasette dependencies.
- [ ] Refresh ports #170. Require published exact identities, SQLite version,
      threadsafety/compile options, file transactions, locking, overlapping
      default-threaded Datasette requests, upstream dependencies/assets/export
      evidence, clean stop/restart, rendered inline hashes and image growth.
      Missing evidence remains a blocker; continue independent browser tests.
- [ ] For a reproduced defect, file an issue in its owning repository with
      artifact identities, commands, output/exit status and expected behavior.
      Delegate ports repairs to the ports agent. Re-run the original guest probe
      after its owning fix; never alter this demo to hide it.
- [ ] Once qualified artifacts exist, install/check their SHA-256 with existing
      tooling. Propose the image pin and matching qualification record together.
      Never fabricate hashes or add a record based on host imports.
- [ ] Write Datasette browser assertions: table/sort/filter, query form and
      vendored scripts with no CSP violations, exact CSV CRLF bytes and parsed
      JSON, JSON download, rejected mutation leaving 12 rows, terminal commit
      giving Pen/3000 and 13 rows, stop/start preservation, reset restoration.
      Assert all encountered inline bodies match the qualified hash set.
- [ ] Exercise overlapping queries, two sandbox owners, worker eviction, live
      startup log tail, occupied port/start failure and cancellation. Leave the
      server up past 120 seconds; assert no registry slot, confirm tracked exit,
      reuse the port and run terminal/notebook commands afterward.
- [ ] Require qualified artifacts for the Datasette acceptance scene: missing
      qualification must fail that scene clearly, not skip as a passing demo.
      Preserve ordinary unqualified/native visibility coverage in unit/browser
      tests. Add bridge and simple-server scenes now; add the mandatory
      Datasette scene with the qualified pin change. Update CI and deploy scene
      assertions.
- [ ] Run the real scenes against local and built static output. Check fallback
      headers/redirect rules and deployed Cloudflare preview headers when a
      preview is available; record any unavailable deployment gate explicitly.
      Block external requests after artifact load. Commit
      `feat: qualify the Datasette browser demo` only with actual evidence.

## Task 7: Verify, review and integration handoff

**Files:** Update task checkboxes/evidence in this plan; revise demo
documentation to describe delivered behavior and measured limits. No generated
artifacts enter git. No implementation completion claim until exact-head hosted
CI passes.

- [ ] Run `deno fmt --check`, `deno lint`, `deno check '**/*.ts'` and
      `deno test --no-check --allow-read --allow-write --allow-env --allow-net --allow-run`.
      Run each new real browser scene once after final code/pin changes.
- [ ] Request a fresh whole-branch Superpowers review with exact base/head,
      approved spec/plan and guest/browser evidence. Address confirmed findings
      in the owning component and rerun affected checks.
- [ ] Prepare a reviewable draft PR description with final behavior, issue #173,
      ports #170 evidence, #168 scope, exact artifact identities and
      verification limitations. Push/publish only within user authorization; do
      not merge.
- [ ] When a remote proposal is authorized, run hosted CI on its exact head and
      inspect every required leg. Report missing credentials, artifacts or
      qualification as unfinished gates, even if unrelated checks pass.

## Plan Self-Review

Spec coverage: deterministic workflow and mutable file (Tasks 3/5/6), command,
ports and readiness (Tasks 2/3), resident/log/shutdown (Tasks 2/3/6),
HTTP/messages (Tasks 1/3), ownership/recovery (Tasks 4/5/6), CSP/COEP/fallback
(Tasks 4/5/6), qualification and native gating (Tasks 5/6), alternatives/scope
preserved by the global constraints. All five review-focus conditions have
owning tests above.

Execution order: Tasks 1 through 5 can progress without qualified Datasette;
Task 6 first proves the simple guest server, then waits for ports qualification
before pinning/enabling Datasette. Task 7 verifies the final proposed head.

## Implementation evidence (local, 2026-09-28)

Tasks 3–5 are implemented. Lifecycle, scoped routing and qualification tests
include the review fixes for heartbeat transport, stale startup diagnostics,
cancellable seed download, reset locking and concurrent owner recovery. The
guest seed probe confirms twelve rows, preserved terminal edits and reset
without removing a foreign sentinel. The built site includes the exact seed,
worker and fallback bytes plus Cloudflare redirects and independent CSP rules.
The Chromium bridge harness covers two owners, GET forms, vendored assets,
HEAD/POST, worker eviction, missing owners, native/absent visibility and exact
CSV/JSON downloads. An eight-second request survives healthy heartbeats without
re-registration. The real guest HTTP baseline proves guest file edits, residence
beyond 120 seconds and stop/restart port reuse.

Task 6 remains blocked by producer qualification: ports #170/#171, toolchain
#180/#201 and kernel #3036. SQLite serialized threading and libyaml repairs are
local reviewed prerequisites; no published Datasette image or qualification
record exists. The qualified Datasette scene is authored but has not run. Its
missing qualification fails explicitly. CI makes that scene mandatory when a
valid published record exists, and reports the absent gate otherwise. No
Datasette runtime or hosted CI completion is claimed.
