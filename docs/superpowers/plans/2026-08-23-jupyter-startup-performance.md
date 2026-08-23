# Jupyter Startup Performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Measure and reduce the Deno cold-start path for the unchanged Jupyter payload to a median of 60 seconds or less, with no cold run above 90 seconds.

**Architecture:** Keep the guest payload unchanged. Add phase timing to the existing Deno harness around image staging, CPython startup, imports, and `IPKernelApp.initialize()`. Use the measurements to optimize the dominant host/VFS/process-module path, then retain the measurements as a repeatable benchmark.

**Tech Stack:** Deno TypeScript, Yurt JS kernel host, staged `.yurtimg`, CPython WASM, yurt-jupyter.

**Spec:** `docs/superpowers/specs/2026-08-23-jupyter-startup-performance-workerhost-design.md`

## Global Constraints

- Do not modify or replace the yurt-jupyter payload.
- Preserve one sandbox, one shared VFS, and guest-side Jupyter TCP sockets.
- Do not use host networking or JupyterLite/Pyodide shortcuts.
- Record cold and warm timings with phase labels.
- Keep existing boot, Python, and Jupyter protocol tests green.

---

### Task 1: Add a phase-timed Deno startup probe

**Files:**
- Create: `tests/jupyter_startup_benchmark.ts`
- Modify: `tests/ash_harness.ts` only if a reusable timestamp/output helper is needed

**Interfaces:**
- Consumes: `bootAshSession`, `typeCommand`, the pinned image, and the existing Deno kernel-root override.
- Produces: machine-readable phase records containing phase name, elapsed milliseconds, cold/warm label, and command output status.

- [ ] **Step 1: Write the failing benchmark assertions**

  Add a probe that runs these commands in order and emits a JSON record after each command:

  ```text
  python3 -c 'import ssl; print("ssl-ready", flush=True)'
  python3 -c 'import zmq; print("zmq-ready", flush=True)'
  python3 -c 'from ipykernel.kernelapp import IPKernelApp; print("ipykernel-ready", flush=True)'
  python3 -c 'from ipykernel.kernelapp import IPKernelApp; app=IPKernelApp.instance(); app.initialize(["-f", "/tmp/yurt-jupyter-k.json"]); print("initialize-ready", flush=True)'
  ```

  Assert every marker appears and assert the probe prints a complete phase record. Add a command-line mode for one cold run and a three-run summary.

- [ ] **Step 2: Run the probe before adding optimization**

  Run:

  ```bash
  YURT_KERNEL_ROOT=/private/tmp/yurtos-kernel-2354-verify deno run --allow-all tests/jupyter_startup_benchmark.ts --cold-runs 3
  ```

  Expected: PASS for all checkpoints and a baseline showing the current approximately two-minute cold startup.

- [ ] **Step 3: Commit the baseline probe**

  ```bash
  git add tests/jupyter_startup_benchmark.ts tests/ash_harness.ts
  git commit -m "test: measure jupyter startup phases"
  ```

### Task 2: Attribute the dominant startup cost

**Files:**
- Modify: `tests/jupyter_startup_benchmark.ts`
- Inspect: `src/stage.ts`, the JS process engine, and the kernel WorkerHost only where the phase records identify them as dominant

**Interfaces:**
- Consumes: Task 1 phase records.
- Produces: a report separating image staging, executable module caching, CPython process startup, import work, and connection-file publication.

- [ ] **Step 1: Add boundary timestamps around image staging and Python process creation**

  Capture timestamps immediately before and after `bootAshSession()` and immediately before and after each `typeCommand`. Keep the existing command markers so a timeout cannot be mistaken for a successful phase.

- [ ] **Step 2: Add counters only at the identified host boundary**

  If staging or process-module preparation dominates, instrument the smallest existing helper responsible for that work. Count calls and total bytes, and report them at process exit. Do not add counters across unrelated syscalls.

- [ ] **Step 3: Run cold and warm measurements**

  Run three fresh-process measurements and three measurements reusing the same Deno process where the harness permits. Record median and maximum values in the lab notebook.

- [ ] **Step 4: Commit the attribution evidence**

  ```bash
  git add tests/jupyter_startup_benchmark.ts docs/superpowers/lab-notebooks/2026-08-22-issue-2304-browser-worker.md
  git commit -m "docs: record jupyter startup baseline"
  ```

### Task 3: Optimize the measured dominant path

**Files:**
- Modify: exactly the host/VFS/process-module file identified by Task 2
- Test: the focused benchmark and the existing boot/Python tests

**Interfaces:**
- Consumes: the measured bottleneck and its counters.
- Produces: the same startup behavior with the median and maximum gates met.

- [ ] **Step 1: Write a focused regression for the measured behavior**

  Encode the smallest observable invariant that would regress if the optimization were removed, such as a required executable-module cache hit or a bounded path-resolution operation count.

- [ ] **Step 2: Run the focused regression red**

  Confirm the test fails against the unoptimized behavior for the expected reason.

- [ ] **Step 3: Implement one minimal optimization**

  Change only the measured bottleneck. Preserve executable/non-executable WASM distinctions and all existing security validation.

- [ ] **Step 4: Run focused and full checks**

  ```bash
  deno fmt --check
  deno lint
  deno check '**/*.ts'
  deno test --allow-all tests/boot_test.ts tests/python_test.ts tests/jupyter_test.ts
  YURT_KERNEL_ROOT=/private/tmp/yurtos-kernel-2354-verify deno run --allow-all tests/jupyter_startup_benchmark.ts --cold-runs 3
  ```

  Expected: all tests pass; median cold startup is at most 60 seconds; no cold run exceeds 90 seconds.

- [ ] **Step 5: Commit the optimization**

  ```bash
  git add src/stage.ts tests/jupyter_startup_benchmark.ts
  git commit -m "perf: reduce jupyter cold startup"
  ```
