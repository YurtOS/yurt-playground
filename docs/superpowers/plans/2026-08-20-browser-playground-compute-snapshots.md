# Browser Playground Compute and Snapshots Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a reproducible browser playground with Python 3, NumPy, real Jupyter execution, and transactional in-place sandbox snapshot restore.

**Architecture:** The kernel/JS host supplies Worker-backed multithreading and an atomic host-resource snapshot contract. yurt-ports composes NumPy and the unchanged yurt-jupyter payload into the image. This repository owns the browser session controller, notebook client, snapshot controls, artifact pins, and end-to-end acceptance tests.

**Tech Stack:** Deno TypeScript, browser Web APIs, Yurt KernelHostInterface JS, Yurt port/image scripts, CPython 3.14.0, standard Jupyter messaging, and browser acceptance tests.

**Spec:** `docs/superpowers/specs/2026-08-19-browser-playground-compute-snapshots-design.md`

## Global Constraints

- Keep `yurt-jupyter` unchanged; consume revision `c30f1073c244aab166c67dc3b9b1ff1048def0d4`.
- Use Python 3.14.0 x86_64 for materialization; never fall back to system Python.
- Use `python` and `python3` as Python 3 aliases; do not support Python 2.
- Use `dialSandboxPort`; do not use `Deno.connect`, host TCP shortcuts, guest egress, or JupyterLite.
- Do not expose snapshot UI until yurtos-kernel#2289 and yurtos-kernel#2304 are green.
- Keep current PTY/Jupyter transports attached until an atomic restore commit succeeds.
- Pin source, dependency lock, materializer, serializer, normalized tree, and final image digests.
- Never silently skip configured-artifact or integration tests.

---

### Task 1: Land the kernel prerequisites

**Repository:** `/Users/sunny/work/yurtos/yurtos-kernel`

**Files:**
- Modify: `packages/kernel/src/snapshot.rs`
- Modify: `packages/kernel/src/lib.rs`
- Modify: `packages/kernel-host-interface-js/mod.ts`
- Modify: `packages/kernel-host-interface-js/kernel-host-interface/kernel_instance.ts`
- Modify: `packages/kernel-host-interface-js/kernel-host-interface/worker_host.ts`
- Test: `packages/kernel-host-interface-js/__tests__/jupyter_worker_smoke_test.ts`
- Test: `packages/kernel-host-interface-js/__tests__/snapshot_resource_transaction_test.ts`

**Interfaces:**
- Produces a JS host API that can preflight and atomically commit a snapshot restore with a reattachment table for PTY and guest-port resources.
- Produces a Worker-backed multi-thread path that runs unchanged yurt-jupyter ipykernel/libzmq and completes a host-bridge cell smoke.

- [ ] **Step 1: Write the red Worker-backed Jupyter smoke.** Start the unchanged yurt-jupyter payload in a browser Worker host, require at least the ipykernel main thread plus libzmq I/O thread, execute `1+1`, and assert the reply and clean shutdown.
- [ ] **Step 2: Write the red resource-transaction tests.** Cover preflight rejection, prepare failure, restore failure, reattachment failure, unchanged old transports after failure, and old-to-new transport swap only after commit.
- [ ] **Step 3: Implement the kernel/JS host contract.** Expose typed preflight/prepare/commit/rollback operations through KernelHostInterface JS; do not make the playground call raw wasm exports.
- [ ] **Step 4: Run focused kernel tests and the Worker smoke.** The tests must run against the browser Worker path, not only a native or fake host.
- [ ] **Step 5: Commit the kernel work and record the exact kernel revision for the playground pin.**

### Task 2: Make the Jupyter payload reproducible

**Repository:** `/Users/sunny/work/yurtos/yurt-playground`

**Files:**
- Create: `artifacts/jupyter-requirements.lock`
- Create: `scripts/materialize-jupyter.ts`
- Create: `scripts/canonical-tree-tar.ts`
- Modify: `artifacts/pins.json`
- Test: `tests/jupyter_materialization_test.ts`

**Interfaces:**
- `materializeJupyter(options: { repoRoot: string; lockPath: string; python: string; outputDir: string }): Promise<{ treeSha256: string; packagePath: string }>`
- `canonicalTreeTar(root: string): Promise<Uint8Array>`
- `sha256Bytes(bytes: Uint8Array): string`

- [ ] **Step 1: Add a failing lock/materialization test.** Assert that the materializer refuses a missing lock, wrong Python version, missing yurt-jupyter revision, compiled extension, duplicate `zmq`, or duplicate `psutil`.
- [ ] **Step 2: Add the fully hashed dependency lock.** Pin every pure-Python dependency with exact version, source URL, and SHA-256; keep pyzmq and psutil excluded according to the unchanged yurt-jupyter staging contract.
- [ ] **Step 3: Add the pyzmq boundary explicitly.** Keep the Python `zmq` package out of the pure-Python materializer, but require the ports image task to stage `ports/pyzmq/build/stage/usr/local/lib/python3.14/site-packages/zmq`; only its compiled `_zmq` extension is supplied by the CPython builtin.
- [ ] **Step 4: Implement the CPython 3.14.0 verifier.** Invoke only the CI-provisioned interpreter and assert `sys.implementation.name == "cpython"`, `sys.version_info == (3, 14, 0)`, and x86_64 architecture.
- [ ] **Step 5: Implement deterministic staging.** Materialize with hash checking and no binary extensions, remove excluded packages, normalize the output tree, emit the package input, and compute the normalized-tree digest.
- [ ] **Step 6: Implement the canonical USTAR serializer.** Use the spec's 512-byte USTAR headers, rightmost fitting path split, fixed octal/checksum fields, zero metadata, UTF-8 validation, and symlink rejection rules.
- [ ] **Step 7: Run the materialization tests from a clean output directory and commit the lock, materializer, serializer, and concrete digests.**

### Task 3: Compose the pinned ports image

**Repository:** `/Users/sunny/work/yurtos/yurt-ports`

**Files:**
- Modify: `ports/playground-image/scripts/build.sh`
- Modify: `ports/playground-image/scripts/package.sh`
- Modify: `ports/playground-image/README.md`
- Modify: `ports/pyzmq/scripts/build.sh`
- Modify: `ports/numpy/scripts/test.sh`
- Test: `ports/playground-image/tests/build_test_base_image.ts`
- Test: `ports/pyzmq/scripts/test.sh`
- Test: `ports/numpy/scripts/test.sh`

**Interfaces:**
- Consumes the NumPy port, the CPython artifact, and the materialized yurt-jupyter package input from Task 2.
- Produces `playground.yurtimg` containing Python 3 aliases, NumPy, and the unchanged Jupyter payload.

- [ ] **Step 1: Write the red clean-build assertion.** Build from fresh port output and assert the image contains `python`, `python3`, NumPy, `ipykernel`, and `jupyter_client`.
- [ ] **Step 2: Wire NumPy, the yurt-jupyter pure-Python tree, and the pyzmq Python tree into the image recipe.** Keep pyzmq's compiled extension baked into CPython and stage only its Python package directory from the pyzmq port.
- [ ] **Step 3: Run the existing NumPy smoke plus `import zmq`, `import ipykernel`, and `import jupyter_client` checks.**
- [ ] **Step 4: Rebuild the image from a clean directory, calculate its SHA-256, and update the playground image pin only after the build is reproducible.**
- [ ] **Step 5: Commit the ports change and record the exact ports revision and image digest.**

### Task 4: Make CI materialize every pinned input

**Repository:** `/Users/sunny/work/yurtos/yurt-playground`

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: `artifacts/pins.json`
- Modify: `scripts/pin-artifacts.ts`
- Modify: `src/pins.ts`
- Modify: `deno.json`
- Test: `tests/layout_test.ts` and `tests/pins_test.ts`

**Interfaces:**
- `pins.json` contains machine-readable kernel, image, yurt-jupyter, lock, materializer, serializer, normalized-tree, and final-image digests.
- CI checks out exact kernel, ports, and yurt-jupyter revisions and fails on any missing or mismatched digest.
- `deno.json` imports `playwright` at the exact version used by `tests/playground_e2e.ts`; CI installs that version's Chromium browser before the browser job.

- [ ] **Step 1: Add red layout/pin tests.** Assert the workflow checks out all three sibling repositories, provisions CPython 3.14.0, builds NumPy dependencies, materializes yurt-jupyter, and verifies every digest.
- [ ] **Step 2: Extend `src/pins.ts` and strict pin resolution.** Add typed fields for the yurt-jupyter source, lock, materializer, serializer, normalized tree, and package digests; reject absent, non-64-lowercase-hex, or mismatched source and generated artifacts.
- [ ] **Step 3: Update CI with exact checkout revisions and explicit Python setup.**
- [ ] **Step 4: Run layout, pin, formatting, lint, type-check, and clean artifact materialization tests.**
- [ ] **Step 5: Add the browser runner job.** Provision Chromium with the pinned Playwright package, download the pinned kernel/image artifacts produced by the materialization job, start `deno task serve`, and run `deno test --no-check --allow-all tests/playground_e2e.ts` against the local COOP/COEP server.
- [ ] **Step 6: Commit CI/pin changes and verify the hosted workflow exercises integration tests rather than skipping them.**

### Task 5: Introduce the playground session controller

**Repository:** `/Users/sunny/work/yurtos/yurt-playground`

**Files:**
- Create: `src/session_controller.ts`
- Modify: `src/boot.ts`
- Test: `tests/session_controller_test.ts`

**Interfaces:**
- `interface PtyTransport { write(bytes: Uint8Array): Promise<void>; close(): void; }`
- `interface JupyterTransport { send(message: Uint8Array): Promise<void>; subscribe(listener: (message: Uint8Array) => void): () => void; close(): void; }`
- `interface SessionTransportSet { pty: PtyTransport; jupyter?: JupyterTransport; }`
- `interface RestorePlan { snapshot: Uint8Array; current: SessionTransportSet; resourceGraphDigest: string; }`
- `interface SessionController { state: "booting" | "ready" | "quiescing" | "restoring" | "failed"; quiesce(): Promise<void>; commitTransportSwap(next: SessionTransportSet): Promise<void>; rollback(): Promise<void>; }`
- `bootPlayground(): Promise<{ session: SessionController; terminal: PtyTransport }>`

- [ ] **Step 1: Write red lifecycle tests.** Assert one sandbox only, input disablement during quiescence, old transports retained until commit, rollback restoring old transports, and no silent second boot.
- [ ] **Step 2: Extract PTY attach/pump ownership from `boot.ts` into the controller boundary without changing ash behavior.**
- [ ] **Step 3: Implement quiesce, commit, and rollback state transitions.**
- [ ] **Step 4: Run existing ash/Python tests plus the new controller tests.**

### Task 6: Add the real Jupyter client and notebook pane

**Repository:** `/Users/sunny/work/yurtos/yurt-playground`

**Files:**
- Create: `src/jupyter.ts`
- Create: `src/jupyter_protocol.ts`
- Modify: `public/index.html`
- Test: `tests/jupyter_test.ts`

**Interfaces:**
- `startGuestKernel(session: SessionController): Promise<JupyterTransport>`
- `executeCell(transport: JupyterTransport, code: string): Promise<JupyterReply>`
- `interface JupyterReply { status: "ok" | "error"; stdout: string; display: string; traceback: string[]; }`

- [ ] **Step 1: Write red configured-artifact tests.** Execute `1+1`, NumPy arithmetic, `!echo hi`, and shared-file checks; fail if the kernel cannot start or artifacts are unresolved.
- [ ] **Step 2: Implement guest ipykernel startup using Python 3 and the existing image payload.**
- [ ] **Step 3: Implement the standard Jupyter message/session handshake over `dialSandboxPort`; keep transport adaptation at the host boundary.**
- [ ] **Step 4: Add the minimal cell editor, execute button, output area, and status/error display above or beside the terminal.**
- [ ] **Step 5: Run the Worker-backed Jupyter smoke and the playground integration tests against the pinned image.**

### Task 7: Add snapshot capture and in-place restore

**Repository:** `/Users/sunny/work/yurtos/yurt-playground`

**Files:**
- Create: `src/snapshot_controller.ts`
- Modify: `src/session_controller.ts`
- Modify: `public/index.html`
- Test: `tests/snapshot_controller_test.ts`

**Interfaces:**
- `interface PreparedRestore { plan: RestorePlan; next: SessionTransportSet; commitToken: Uint8Array; }`
- `interface SnapshotHost { preflight(bytes: Uint8Array): Promise<RestorePlan>; capture(): Promise<Uint8Array>; prepareRestore(plan: RestorePlan): Promise<PreparedRestore>; commitRestore(prepared: PreparedRestore): Promise<void>; rollbackRestore(prepared: PreparedRestore): Promise<void>; }`
- `saveSnapshot(host: SnapshotHost): Promise<Blob>`
- `restoreSnapshot(session: SessionController, host: SnapshotHost, file: File): Promise<void>`

- [ ] **Step 1: Write red controller tests.** Cover download bytes, version validation, invalid input, preflight rejection, prepare failure, restore failure, reattachment failure, old transport usability after failure, and successful atomic swap.
- [ ] **Step 2: Implement snapshot file validation and download naming as a versioned `.yurtsnapshot` Blob.**
- [ ] **Step 3: Implement capture with input disablement, checkpoint barrier, canonical capture, and guaranteed barrier release.**
- [ ] **Step 4: Implement restore as a session transaction.** Validate and preflight first, call `session.quiesce()` while retaining current transports, prepare the host restore, commit the kernel/resource restore, call `session.commitTransportSwap(prepared.next)`, and invoke both host rollback and `session.rollback()` on any failure before success is reported.
- [ ] **Step 5: Add Save snapshot and Restore snapshot controls with progress/error status.**
- [ ] **Step 6: Run focused snapshot tests and the kernel resource-transaction smoke.**

### Task 8: Add browser end-to-end acceptance

**Repository:** `/Users/sunny/work/yurtos/yurt-playground`

**Files:**
- Create: `tests/playground_e2e.ts`
- Modify: `tests/python_test.ts`
- Modify: `tests/layout_test.ts`
- Test fixtures: `artifacts/` remains ignored; tests resolve only pinned artifacts.

**Interfaces:**
- Browser harness starts the local COOP/COEP server and exposes deterministic download/file-selection hooks.
- Integration tests fail on artifact resolution errors; no configured-artifact path returns a successful skip.

- [ ] **Step 1: Write red browser tests for boot, ash up-arrow history, Python 3, and NumPy.**
- [ ] **Step 2: Add notebook tests for `1+1`, NumPy, `!echo hi`, and shared VFS files.**
- [ ] **Step 3: Add snapshot round-trip tests: create marker, download, mutate, restore, verify from ash and notebook, and verify both transports reconnect.**
- [ ] **Step 4: Add failed-restore tests proving the original terminal and notebook remain usable and unchanged.**
- [ ] **Step 5: Run the browser suite against a clean materialized pinned image and record evidence.**

### Task 9: Run the complete gates and publish

**Repository:** `/Users/sunny/work/yurtos/yurt-playground`

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/plans/2026-08-17-browser-yurt-playground.md` to point at the completed arc.

- [ ] **Step 1: Run `deno fmt --check`.**
- [ ] **Step 2: Run `deno lint`.**
- [ ] **Step 3: Run `deno check '**/*.ts'`.**
- [ ] **Step 4: Run `deno test --no-check` with the CI permissions.**
- [ ] **Step 5: Run the clean pinned image and browser acceptance workflow.**
- [ ] **Step 6: Request review only after all gates exercise the integration path.**
- [ ] **Step 7: Commit, push, and open the scoped PRs; merge only after explicit instruction.**
