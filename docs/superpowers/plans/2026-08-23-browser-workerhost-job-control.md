# Browser WorkerHost Job-Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the browser-only background-child stall so the real Chromium
Jupyter gate reaches NumPy and verifies clean shutdown.

**Architecture:** Reproduce the difference between Deno and Chromium with the
existing real WorkerHost path. Instrument the child leader and pthread Worker
lifecycle at the kernel boundary, identify whether shell prompt loss is caused
by spawn admission, terminal/job-control state, relay completion, or child
termination, then add the smallest kernel regression and fix.

**Tech Stack:** TypeScript/Deno WorkerHost, browser Workers,
SharedArrayBuffer/Atomics, BusyBox ash, Playwright.

**Spec:**
`docs/superpowers/specs/2026-08-23-jupyter-startup-performance-workerhost-design.md`

**Kernel issue:**
[YurtOS/yurtos-kernel#2361](https://github.com/YurtOS/yurtos-kernel/issues/2361)

## Global Constraints

- Use actual browser Workers and the existing shared-memory relay.
- Do not mock the child process or replace guest Jupyter networking.
- Preserve `WorkerHost` as the production `ThreadHost`.
- Kernel changes belong in `yurtos-kernel`; browser orchestration changes belong
  in `yurt-playground`.
- Run playground commands from this worktree. The kernel agent must create and
  use its own isolated branch/worktree based on the sibling checkout (record its
  absolute path in the lab notebook); never run a kernel `git add`, commit, or
  test command from the playground root or a shared verification checkout.
- Tasks 2–3 are delegated to a kernel agent under issue #2361. The playground
  agent must not edit or commit kernel files. The playground agent may consume
  the resulting kernel branch/artifact only after the kernel agent reports its
  focused tests and commit SHA.
- Do not claim acceptance until Chromium runs `1+1`, NumPy arithmetic, and
  explicit shutdown.

---

### Task 1: Add a minimal browser reproduction

**Files:**

- Modify: `tests/playground_e2e.ts`
- Create: `tests/workerhost_background_child_e2e.ts`
- Modify: `src/page.ts` and `src/coordinator_worker.ts` to support a test-only
  `?mode=workerhost-repro` shell-only startup mode
- Modify: `scripts/serve.ts` to enable the mode only in the test server bundle

**Interfaces:**

- Consumes: the real playground server, pinned artifacts, and xterm terminal.
- Produces: a deterministic comparison of short-lived and long-running
  background commands, including prompt/marker observations.

- [ ] **Step 1: Write the failing browser assertion**

  Add a test-only `mode=workerhost-repro` start option. `scripts/serve.ts` must
  inject a test-build constant only for the local reproduction bundle;
  production/static builds set it false and reject this mode. `src/page.ts` must
  pass the mode in the existing worker start message;
  `src/coordinator_worker.ts` must boot the sandbox and expose the shell without
  calling `startGuestKernel`. Boot that URL, wait for the shell-ready signal,
  and drive these commands through terminal input:

  ```text
  sleep 3 & echo SHORT_BG_READY
  python3 -c 'import ipykernel; print("PYTHON_READY", flush=True)' & echo LONG_BG_READY
  ```

  Assert the short-lived command returns its marker and prompt. Assert the
  long-running command returns its marker and prompt within a bounded 30-second
  diagnostic window. Run this against the known pre-fix reproduction checkout;
  if the current verification checkout passes, record that non-reproduction and
  continue to the real Jupyter gate rather than treating the control as a new
  failure.

- [ ] **Step 2: Run the browser reproduction red**

  ```bash
  YURT_KERNEL_ROOT=/private/tmp/yurtos-kernel-2354-verify deno run --allow-all tests/workerhost_background_child_e2e.ts --mode workerhost-repro
  ```

  The test must parse `--mode` from `Deno.args` and use the supplied value to
  select the `workerhost-repro` URL; reject missing or unknown modes. Expected
  on the known reproduction checkout: the short background command passes and
  the long-running child does not return the shell prompt. If the pinned
  verification checkout passes both assertions, record that the shell-only stall
  is no longer reproducible and use the full Jupyter gate to identify the
  remaining divergence.

- [ ] **Step 3: Commit the red reproduction**

  ```bash
  git add src/page.ts src/coordinator_worker.ts scripts/serve.ts tests/playground_e2e.ts tests/workerhost_background_child_e2e.ts
  git commit -m "test: reproduce browser background child stall"
  ```

  Expected: the red reproduction is committed with the shell-only test gate and
  its browser orchestration; production bundles reject the test mode.

### Task 2: Instrument WorkerHost lifecycle boundaries

**Delegation:** Kernel agent, issue
[#2361](https://github.com/YurtOS/yurtos-kernel/issues/2361). Before starting,
the kernel agent creates an isolated worktree and keeps this variable in its
shell for all kernel commands:

```bash
KERNEL_WORKTREE=/private/tmp/yurtos-kernel-2361-agent
git -C /Users/sunny/work/yurtos/yurtos-kernel worktree add -b fix/issue-2361 "$KERNEL_WORKTREE" origin/main
```

Set `KERNEL_TRACE_FILES` to the exact kernel files changed by the trace and
record the final value in
`docs/superpowers/lab-notebooks/2026-08-22-issue-2304-browser-worker.md`. It
must include `worker_host.ts`, and must also include `process_engine.ts` if the
trace instrumentation touches it. Task 3 reads that recorded value rather than
relying on a shell variable surviving between agents:

```bash
KERNEL_TRACE_FILES=("packages/kernel-host-interface-js/kernel-host-interface/worker_host.ts")
# If the trace touches process_engine.ts, append that exact path before commit
# and record the final value in the lab notebook:
# KERNEL_TRACE_FILES+=("packages/kernel-host-interface-js/kernel-host-interface/process_engine.ts")
```

**Files:** Kernel agent, from the kernel worktree:

- Modify:
  `packages/kernel-host-interface-js/kernel-host-interface/worker_host.ts`
- Modify:
  `packages/kernel-host-interface-js/kernel-host-interface/process_engine.ts`
  only if the trace proves the state is lost there

Playground agent, from this worktree:

- Modify: `tests/workerhost_background_child_e2e.ts` to collect bounded
  diagnostics
- Modify: `src/coordinator_worker.ts` to forward bounded trace messages

**Interfaces:**

- Consumes: the red browser reproduction.
- Produces: phase records for leader Worker ready, `run`, child pthread
  spawn/start, `relayComplete`, terminal exit, `recordExit`, and
  `shellPromptReturn`.

- [ ] **Step 1: Add bounded diagnostic events**

  Add an optional bounded `WorkerHostTraceEvent` sink to the WorkerHost test
  options. Emit events only when that sink is present: pid/tid, event name, and
  monotonic timestamp. Trace `spawnLeader`, `startLeader`, pthread `spawn`,
  pthread `start`, `relayComplete`, terminal completion, `recordExit`, and
  `shellPromptReturn`. The Deno harness writes the events directly; the browser
  coordinator forwards them as bounded `workerhost-trace` messages to the page,
  where the test collects them. Do not log guest payload or unbounded relay
  bytes.

- [ ] **Step 2: Run Deno and Chromium with identical event names**

  Compare the first missing event. The first divergence determines the next
  hypothesis; do not change lifecycle code before this comparison.

  Record the final `KERNEL_TRACE_FILES` and the selected
  `KERNEL_IMPLEMENTATION_FILE` in the lab notebook before handing the work to a
  new agent session, using these machine-readable keys:

  ```text
  kernel_trace_files=packages/kernel-host-interface-js/kernel-host-interface/worker_host.ts
  kernel_implementation_file=packages/kernel-host-interface-js/kernel-host-interface/worker_host.ts
  ```

- [ ] **Step 3: Commit the instrumentation separately**

  The kernel agent commits only from `$KERNEL_WORKTREE`:

  ```bash
  cd "$KERNEL_WORKTREE"
  git add "${KERNEL_TRACE_FILES[@]}"
  git commit -m "test: trace browser workerhost child lifecycle"
  ```

  The playground agent commits only from this worktree:

  ```bash
  cd /Users/sunny/work/yurtos/yurt-playground/.worktrees/issue-2304-completion
  git add src/coordinator_worker.ts tests/workerhost_background_child_e2e.ts
  git commit -m "test: collect browser workerhost lifecycle trace"
  ```

### Task 3: Add and fix the narrow kernel regression

**Delegation:** Continue with the same kernel agent and issue #2361. The agent
must report the exact kernel commit SHA and focused test output back to the
playground agent before Task 4 updates the pinned artifact.

Before starting this task in a new agent session, restore the recorded kernel
worktree variable and verify that it is an isolated worktree:

```bash
KERNEL_WORKTREE=/private/tmp/yurtos-kernel-2361-agent
git -C "$KERNEL_WORKTREE" status --short
```

Read and assign the exact `KERNEL_IMPLEMENTATION_FILE` recorded by Task 2 from
the lab notebook before editing or committing:

```bash
KERNEL_IMPLEMENTATION_FILE=$(rg -m1 '^kernel_implementation_file=' /Users/sunny/work/yurtos/yurt-playground/.worktrees/issue-2304-completion/docs/superpowers/lab-notebooks/2026-08-22-issue-2304-browser-worker.md | cut -d= -f2-)
test -n "$KERNEL_IMPLEMENTATION_FILE"
```

**Files:**

- Modify: the WorkerHost/process-engine file identified by Task 2; update this
  Files list with its exact path before implementation
- Test: `packages/kernel-host-interface-js/__tests__/host_spawn_wait_test.ts`

**Interfaces:**

- Consumes: the first divergent lifecycle event from Task 2.
- Produces: a red kernel regression that exercises the failing lifecycle and a
  minimal fix preserving existing admission/teardown ownership.

- [ ] **Step 1: Write the smallest failing kernel test**

  Use the existing real-Worker test helpers and assert the exact missing
  transition, such as a child background process retaining a live leader record
  while the parent resumes or a terminal completion reaching `recordExit`
  exactly once.

- [ ] **Step 2: Run the focused test red**

  ```bash
  cd "$KERNEL_WORKTREE"
  deno test --allow-all packages/kernel-host-interface-js/__tests__/host_spawn_wait_test.ts
  ```

- [ ] **Step 3: Implement the minimal ownership/state fix**

  Preserve the existing WorkerHost admission and terminal-completion claims.
  Change only the state transition proven by Task 2; do not add a second
  scheduler or a browser-only path.

- [ ] **Step 4: Run the focused kernel suite green**

  ```bash
  cd "$KERNEL_WORKTREE"
  deno test --allow-all packages/kernel-host-interface-js/__tests__/host_spawn_wait_test.ts packages/kernel-host-interface-js/__tests__/worker_host_test.ts
  ```

- [ ] **Step 5: Commit the kernel fix**

  ```bash
  cd "$KERNEL_WORKTREE"
  git add "$KERNEL_IMPLEMENTATION_FILE" packages/kernel-host-interface-js/__tests__/host_spawn_wait_test.ts
  git commit -m "fix: resume browser shell after worker child launch"
  ```

### Task 4: Add explicit Jupyter shutdown acceptance

**Prerequisite:** The playground agent must consume the kernel agent's reported
fix commit before running this task. The kernel agent must push its branch and
open the kernel PR, then stop and request explicit user authorization before
merging. Do not run `gh pr merge` without that authorization. After the
authorized merge, record the merged commit SHA. In the kernel worktree, build
the fixed WASM and record its artifact SHA-256. In this playground worktree,
update `artifacts/pins.json` to that merged kernel revision and digest, then
materialize the matching pinned artifact with the existing pin workflow:

```bash
set -euo pipefail
KERNEL_WORKTREE=/private/tmp/yurtos-kernel-2361-agent
cd "$KERNEL_WORKTREE"
git push --set-upstream origin fix/issue-2361
git fetch origin main
# Discover or create the kernel PR, then stop for user merge authorization.
KERNEL_PR_NUMBER=$(gh pr list --repo YurtOS/yurtos-kernel --state all --head fix/issue-2361 --json number --jq '.[0].number')
if [ -z "$KERNEL_PR_NUMBER" ]; then
  KERNEL_PR_URL=$(gh pr create --repo YurtOS/yurtos-kernel --head fix/issue-2361 --base main --title "fix: resume browser shell after worker child launch" --body "Tracks the browser WorkerHost acceptance blocker.")
  KERNEL_PR_NUMBER=$(gh pr view "$KERNEL_PR_URL" --repo YurtOS/yurtos-kernel --json number --jq '.number')
fi
test -n "$KERNEL_PR_NUMBER"
gh pr view "$KERNEL_PR_NUMBER" --repo YurtOS/yurtos-kernel
# Stop here. Continue only after explicit user authorization and a completed merge.
git fetch origin main
KERNEL_PR_STATE=$(gh pr view "$KERNEL_PR_NUMBER" --repo YurtOS/yurtos-kernel --json state,mergedAt --jq '.state + ":" + (.mergedAt // "")')
case "$KERNEL_PR_STATE" in
  MERGED:*) ;;
  *) echo "kernel PR is not merged; stop before pinning: $KERNEL_PR_STATE" >&2; exit 1 ;;
esac
MERGED_KERNEL_SHA=$(gh pr view "$KERNEL_PR_NUMBER" --repo YurtOS/yurtos-kernel --json mergeCommit --jq '.mergeCommit.oid // empty')
test -n "$MERGED_KERNEL_SHA"
test "$MERGED_KERNEL_SHA" != "null"
git checkout --detach "$MERGED_KERNEL_SHA"
test "$(git rev-parse HEAD)" = "$MERGED_KERNEL_SHA"
scripts/build-kernel-wasm.sh
cd /Users/sunny/work/yurtos/yurt-playground/.worktrees/issue-2304-completion
test -s "$KERNEL_WORKTREE/target/kernel-wasm/release/yurt_kernel.wasm"
KERNEL_WASM_SHA=$(shasum -a 256 "$KERNEL_WORKTREE/target/kernel-wasm/release/yurt_kernel.wasm" | awk '{print $1}')
test -n "$KERNEL_WASM_SHA"
artifact_backup=$(mktemp -d)
restore_artifacts() {
  if [ -f "$artifact_backup/yurt_kernel.wasm" ]; then mv "$artifact_backup/yurt_kernel.wasm" artifacts/; fi
  if [ -f "$artifact_backup/playground.yurtimg" ]; then mv "$artifact_backup/playground.yurtimg" artifacts/; fi
}
trap restore_artifacts EXIT
mv artifacts/yurt_kernel.wasm artifacts/playground.yurtimg "$artifact_backup"/
# Write the merged revision and rebuilt artifact digest before pin resolution.
jq --arg rev "$MERGED_KERNEL_SHA" --arg sha "$KERNEL_WASM_SHA" \
  '.kernelWasm.rev = $rev | .kernelWasm.sha256 = $sha' \
  artifacts/pins.json > "$artifact_backup/pins.json"
mv "$artifact_backup/pins.json" artifacts/pins.json
YURT_KERNEL_ROOT="$KERNEL_WORKTREE" deno task pin
trap - EXIT
```

Do not start the acceptance gate until `artifacts/pins.json` and the
materialized `artifacts/yurt_kernel.wasm` match the kernel agent's reported
merged commit and digest. The move above forces `resolveArtifacts()` to read the
freshly built sibling artifacts instead of validating stale blobs; retain
`artifact_backup` until the new hashes pass. Commit the pin update separately in
the playground:

```bash
cd /Users/sunny/work/yurtos/yurt-playground/.worktrees/issue-2304-completion
git add artifacts/pins.json
git commit -m "chore: pin workerhost kernel fix"
```

**Files:**

- Modify: `src/jupyter_transport.ts` to expose a shutdown request/close
  observation
- Modify: `src/coordinator_worker.ts` to provide the shutdown path
- Modify: `src/boot.ts` so `bootPlayground().stop()` owns and reports
  guest-session termination
- Modify: `src/page.ts` to expose shutdown messages and DOM assertions to
  Playwright
- Modify: `src/notebook.ts` to render shutdown completion state
- Modify: `tests/playground_e2e.ts` to assert shutdown and guest-process exit
- Modify: `tests/boot_test.ts`, `tests/python_test.ts`, and
  `tests/ash_harness.ts` to await the async stop result at every caller

**Interfaces:**

- Consumes: a ready Jupyter transport and the existing session lifecycle.
- Produces: an observable shutdown result: a `ToWorker` `shutdown` message
  causes a standard Jupyter `shutdown_request`, the control transport emits a
  completed `waitClosed()` signal, and the coordinator emits `shutdown-complete`
  only after `bootPlayground().stop()` has observed the guest process exit and
  released session resources. The page must render `shutdown-complete` as
  `data-testid="shutdown-status"` with `data-guest-exited="true"` so Playwright
  can observe the payload without reaching into the Worker directly.
  `src/notebook.ts` must render a shutdown button with
  `data-testid="notebook-shutdown"`; `src/page.ts` must post the `shutdown`
  message when it is clicked and render the coordinator's `shutdown-complete`
  result into the shutdown status element.

- [ ] **Step 1: Write the failing shutdown assertion**

  After the NumPy assertion, send the `ToWorker` `shutdown` message. Await
  `JupyterTransport.waitClosed()`, then assert the coordinator's
  `shutdown-complete` payload contains `guestExited: true` and no live session
  identifier, all before calling browser/server teardown.

- [ ] **Step 2: Run acceptance against the landed kernel artifact**

  ```bash
  YURT_KERNEL_ROOT="$KERNEL_WORKTREE" deno run --allow-all tests/playground_e2e.ts
  ```

  Expected: the gate reaches Jupyter ready, evaluates `1+1` and the NumPy sum,
  observes `shutdown-status[data-guest-exited="true"]`, and exits with no live
  guest session. Any failure is diagnosed against the landed kernel artifact,
  not the pre-fix reproduction.

- [ ] **Step 3: Implement the smallest shutdown lifecycle hook**

  Add `JupyterTransport.waitClosed()`, with `close()` resolving the same
  completion state, and add explicit shutdown message/result types. In
  `boot.ts`, capture the `runStartAsync()` Promise, split idempotent PTY-close
  cleanup from the public `stop()` method, and have `stop()` close the PTY then
  await that captured Promise before reporting `guestExited: true`. The process
  promise's `.finally()` must call internal cleanup directly rather than call
  `stop()` recursively. Update every caller in `tests/boot_test.ts`,
  `tests/python_test.ts`, and `tests/ash_harness.ts` to await the Promise, and
  update the coordinator's error cleanup to await it as well. Do not kill the
  browser page as the assertion; make the guest process/transport state
  observable first.

- [ ] **Step 4: Run the complete acceptance gate**

  Assert Jupyter ready, `1+1` equals `2`, and NumPy sum equals `3`. Then run:

  ```ts
  await page.getByTestId("notebook-shutdown").click();
  const shutdown = page.getByTestId("shutdown-status");
  await shutdown.waitFor({ state: "visible" });
  await expect(shutdown).toHaveAttribute("data-guest-exited", "true");
  ```

  Only after these assertions perform browser/server teardown.

- [ ] **Step 5: Commit the playground acceptance changes**

  ```bash
  git add src/jupyter_transport.ts src/coordinator_worker.ts src/boot.ts src/page.ts src/notebook.ts tests/playground_e2e.ts tests/boot_test.ts tests/python_test.ts tests/ash_harness.ts
  git commit -m "test: assert jupyter clean shutdown in browser"
  ```
