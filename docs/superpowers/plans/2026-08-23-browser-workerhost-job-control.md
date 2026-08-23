# Browser WorkerHost Job-Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the browser-only background-child stall so the real Chromium Jupyter gate reaches NumPy and verifies clean shutdown.

**Architecture:** Reproduce the difference between Deno and Chromium with the existing real WorkerHost path. Instrument the child leader and pthread Worker lifecycle at the kernel boundary, identify whether shell prompt loss is caused by spawn admission, terminal/job-control state, relay completion, or child termination, then add the smallest kernel regression and fix.

**Tech Stack:** TypeScript/Deno WorkerHost, browser Workers, SharedArrayBuffer/Atomics, BusyBox ash, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-23-jupyter-startup-performance-workerhost-design.md`

## Global Constraints

- Use actual browser Workers and the existing shared-memory relay.
- Do not mock the child process or replace guest Jupyter networking.
- Preserve `WorkerHost` as the production `ThreadHost`.
- Kernel changes belong in `yurtos-kernel`; browser orchestration changes belong in `yurt-playground`.
- Do not claim acceptance until Chromium runs `1+1`, NumPy arithmetic, and explicit shutdown.

---

### Task 1: Add a minimal browser reproduction

**Files:**
- Modify: `tests/playground_e2e.ts`
- Create: `tests/workerhost_background_child_e2e.ts` if the reproduction should remain separate from Jupyter acceptance

**Interfaces:**
- Consumes: the real playground server, pinned artifacts, and xterm terminal.
- Produces: a deterministic comparison of short-lived and long-running background commands, including prompt/marker observations.

- [ ] **Step 1: Write the failing browser assertion**

  Boot the page, wait for the shell, and drive these commands through the terminal input:

  ```text
  sleep 3 & echo SHORT_BG_READY
  python3 -c 'import ipykernel; print("PYTHON_READY", flush=True)' & echo LONG_BG_READY
  ```

  Assert the short-lived command returns its marker and prompt. Assert the long-running command returns its marker and prompt within a bounded 30-second diagnostic window. The second assertion must fail on the current browser path while the equivalent Deno harness passes.

- [ ] **Step 2: Run the browser reproduction red**

  ```bash
  YURT_KERNEL_ROOT=/private/tmp/yurtos-kernel-2354-verify deno run --allow-all tests/workerhost_background_child_e2e.ts
  ```

  Expected: the short background command passes and the long-running child does not return the shell prompt.

- [ ] **Step 3: Commit the red reproduction**

  ```bash
  git add tests/workerhost_background_child_e2e.ts
  git commit -m "test: reproduce browser background child stall"
  ```

### Task 2: Instrument WorkerHost lifecycle boundaries

**Files:**
- Modify: `yurtos-kernel/packages/kernel-host-interface-js/kernel-host-interface/worker_host.ts`
- Modify: `yurtos-kernel/packages/kernel-host-interface-js/kernel-host-interface/process_engine.ts` only if the trace proves the state is lost there
- Modify: `tests/workerhost_background_child_e2e.ts` to collect bounded diagnostics

**Interfaces:**
- Consumes: the red browser reproduction.
- Produces: phase records for leader Worker ready, `run`, child pthread spawn/start, relay completion, terminal exit, and shell prompt return.

- [ ] **Step 1: Add bounded diagnostic events**

  Emit structured events only for the reproduction: pid/tid, event name, and monotonic timestamp. Trace `spawnLeader`, `startLeader`, pthread `spawn`, pthread `start`, terminal completion, and `recordExit`. Do not log guest payload or unbounded relay bytes.

- [ ] **Step 2: Run Deno and Chromium with identical event names**

  Compare the first missing event. The first divergence determines the next hypothesis; do not change lifecycle code before this comparison.

- [ ] **Step 3: Commit the instrumentation separately**

  ```bash
  git add packages/kernel-host-interface-js/kernel-host-interface/worker_host.ts tests/workerhost_background_child_e2e.ts
  git commit -m "test: trace browser workerhost child lifecycle"
  ```

### Task 3: Add and fix the narrow kernel regression

**Files:**
- Modify: the WorkerHost/process-engine file identified by Task 2
- Test: `yurtos-kernel/packages/kernel-host-interface-js/__tests__/host_spawn_wait_test.ts`

**Interfaces:**
- Consumes: the first divergent lifecycle event from Task 2.
- Produces: a red kernel regression that exercises the failing lifecycle and a minimal fix preserving existing admission/teardown ownership.

- [ ] **Step 1: Write the smallest failing kernel test**

  Use the existing real-Worker test helpers and assert the exact missing transition, such as a child background process retaining a live leader record while the parent resumes or a terminal completion reaching `recordExit` exactly once.

- [ ] **Step 2: Run the focused test red**

  ```bash
  deno test --allow-all packages/kernel-host-interface-js/__tests__/host_spawn_wait_test.ts
  ```

- [ ] **Step 3: Implement the minimal ownership/state fix**

  Preserve the existing WorkerHost admission and terminal-completion claims. Change only the state transition proven by Task 2; do not add a second scheduler or a browser-only path.

- [ ] **Step 4: Run the focused kernel suite green**

  ```bash
  deno test --allow-all packages/kernel-host-interface-js/__tests__/host_spawn_wait_test.ts packages/kernel-host-interface-js/__tests__/worker_host_test.ts
  ```

- [ ] **Step 5: Commit the kernel fix**

  ```bash
  git add packages/kernel-host-interface-js/kernel-host-interface/worker_host.ts packages/kernel-host-interface-js/__tests__/host_spawn_wait_test.ts
  git commit -m "fix: resume browser shell after worker child launch"
  ```

### Task 4: Add explicit Jupyter shutdown acceptance

**Files:**
- Modify: `src/jupyter_transport.ts` to expose a shutdown request/close observation
- Modify: `src/coordinator_worker.ts` to provide the shutdown path
- Modify: `src/session_controller.ts` to report guest-session termination
- Modify: `tests/playground_e2e.ts` to assert shutdown and guest-process exit

**Interfaces:**
- Consumes: a ready Jupyter transport and the existing session lifecycle.
- Produces: an observable shutdown result: control-channel shutdown request acknowledged by transport closure, followed by guest process exit and no lingering session resources.

- [ ] **Step 1: Write the failing shutdown assertion**

  After the NumPy assertion, request kernel shutdown through the Jupyter control channel, await transport closure, then assert the coordinator reports the guest process exited before calling browser/server teardown.

- [ ] **Step 2: Run the acceptance test red or blocked at the current WorkerHost stall**

  ```bash
  YURT_KERNEL_ROOT=/private/tmp/yurtos-kernel-2354-verify deno run --allow-all tests/playground_e2e.ts
  ```

- [ ] **Step 3: Implement the smallest shutdown lifecycle hook**

  Reuse existing `JupyterTransport.close()` and session stop ownership. Do not kill the browser page as the assertion; make the guest process/transport state observable first.

- [ ] **Step 4: Run the complete acceptance gate**

  Assert Jupyter ready, `1+1` equals `2`, NumPy sum equals `3`, shutdown completes, and the browser/server teardown reports no live guest session.

- [ ] **Step 5: Commit the playground acceptance changes**

  ```bash
  git add src tests/playground_e2e.ts
  git commit -m "test: assert jupyter clean shutdown in browser"
  ```
