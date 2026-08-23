# Jupyter Startup Performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Measure and reduce the Deno cold-start path for the unchanged Jupyter
payload to a median of 60 seconds or less, with no cold run above 90 seconds.

**Architecture:** Keep the guest payload unchanged. Add phase timing to the
existing Deno harness around image staging, CPython startup, imports, and
`IPKernelApp.initialize()`. Use the measurements to optimize the dominant
host/VFS/process-module path, then retain the measurements as a repeatable
benchmark.

**Tech Stack:** Deno TypeScript, Yurt JS kernel host, staged `.yurtimg`, CPython
WASM, yurt-jupyter.

**Spec:**
`docs/superpowers/specs/2026-08-23-jupyter-startup-performance-workerhost-design.md`

## Global Constraints

- Do not modify or replace the yurt-jupyter payload.
- Preserve one sandbox, one shared VFS, and guest-side Jupyter TCP sockets.
- Do not use host networking or JupyterLite/Pyodide shortcuts.
- Record cold and warm timings with phase labels. A cold run is one fresh Deno
  process and one fresh sandbox; a warm run reuses the Deno process and
  harness-owned resources as documented by the benchmark.
- Keep existing boot, Python, and Jupyter protocol tests green.

---

### Task 1: Add a phase-timed Deno startup probe

**Files:**

- Create: `tests/jupyter_startup_benchmark.ts`
- Modify: `tests/ash_harness.ts` only if a reusable timestamp/output helper is
  needed

**Interfaces:**

- Consumes: `bootAshSession`, `typeCommand`, the pinned image, and the existing
  Deno kernel-root override.
- Produces: machine-readable phase records containing phase name, elapsed
  milliseconds, cold/warm label, and command output status.

- [ ] **Step 1: Write the failing benchmark assertions**

  Add a probe that starts one Python process and emits a JSON record for each
  phase. Do not launch one Python process per phase: that would measure four
  interpreter startups rather than the real Jupyter launcher. The single
  diagnostic script must flush these markers in order:

  ```text
  python3 -c 'import json, time; t=time.monotonic(); import ssl; print(json.dumps({"phase":"ssl","elapsed_ms":round((time.monotonic()-t)*1000)}), flush=True); t=time.monotonic(); import zmq; print(json.dumps({"phase":"zmq","elapsed_ms":round((time.monotonic()-t)*1000)}), flush=True); t=time.monotonic(); from ipykernel.kernelapp import IPKernelApp; print(json.dumps({"phase":"ipykernel-import","elapsed_ms":round((time.monotonic()-t)*1000)}), flush=True); t=time.monotonic(); app=IPKernelApp.instance(); app.initialize(["-f", "/tmp/yurt-jupyter-k.json"]); print(json.dumps({"phase":"initialize","elapsed_ms":round((time.monotonic()-t)*1000)}), flush=True); app.kernel.do_shutdown(False); raise SystemExit(0)'
  ```

  Treat the ordered import timings as cumulative checkpoints, not isolated
  module costs: shared and lazy transitive dependencies are intentionally
  charged to the checkpoint where they first load. If import ownership is
  material to the optimization, add separate fresh-process probes for each
  import and use those independent measurements for attribution.

  Assert every phase record appears, the connection file contains all five
  Jupyter ports, call the payload's actual `app.kernel.do_shutdown(False)` hook,
  and then require the Python process to exit. Add `--single-run`,
  `--warm-runs`, `--warmup-runs`, `--run-label LABEL`, `--json-out PATH`, and
  `--summarize PATH...` modes. Reject `--warm-runs` unless a distinct
  `--warmup-runs` value is also supplied, and validate both as non-negative
  integers. A single run writes its complete machine-readable result to `PATH`;
  `--summarize` reads those result files and prints median and maximum cold
  totals and phase values. It must require the expected input files, sort each
  metric, select the middle value for odd sample counts, average the two middle
  values for even sample counts, and print the maximum; it must fail if a result
  is missing or malformed. `--warm-runs N` must discard the configured warm-up
  runs before recording N warm samples. For
  `--warm-runs 3 --json-out
  warm.json`, write an array of three recorded
  warm-run records to the one file, and allow `--summarize` to read either a
  single record or such an array. The benchmark itself must not label multiple
  sessions in one Deno process as cold.

- [ ] **Step 2: Run the probe before adding optimization**

  Run:

  ```bash
  results_dir=$(mktemp -d)
  for run in 1 2 3; do
    YURT_KERNEL_ROOT=/private/tmp/yurtos-kernel-2354-verify deno run --allow-all tests/jupyter_startup_benchmark.ts --single-run --run-label "cold-$run" --json-out "$results_dir/cold-$run.json"
  done
  YURT_KERNEL_ROOT=/private/tmp/yurtos-kernel-2354-verify deno run --allow-all tests/jupyter_startup_benchmark.ts --summarize "$results_dir"/cold-*.json
  ```

  Expected: PASS for all checkpoints and three independent timing records
  showing the current approximately two-minute cold startup. The summary must
  report the median and maximum across those three processes.

- [ ] **Step 3: Commit the baseline probe**

  ```bash
  git add tests/jupyter_startup_benchmark.ts tests/ash_harness.ts
  git commit -m "test: measure jupyter startup phases"
  ```

### Task 2: Attribute the dominant startup cost

**Files:**

- Modify: `tests/jupyter_startup_benchmark.ts`
- Inspect: `src/stage.ts`, the JS process engine, and the kernel WorkerHost only
  where the phase records identify them as dominant
- Modify:
  `docs/superpowers/lab-notebooks/2026-08-22-issue-2304-browser-worker.md` to
  record the measured implementation path and owning worktree

**Interfaces:**

- Consumes: Task 1 phase records.
- Produces: a report separating image staging, executable module caching,
  CPython process startup, import work, and connection-file publication.

- [ ] **Step 1: Add boundary timestamps around image staging and Python process
      creation**

  Capture timestamps immediately before and after `bootAshSession()` and the
  single Python launcher command. Keep the phase markers and connection-file
  validation so a timeout cannot be mistaken for a successful phase. Report
  image staging, process creation, each import, initialization, and
  connection-file publication separately.

- [ ] **Step 2: Add counters only at the identified host boundary**

  If staging or process-module preparation dominates, instrument the smallest
  existing helper responsible for that work. Count calls and total bytes, and
  report them at process exit. Do not add counters across unrelated syscalls.

  Record the exact measured implementation file and owning worktree in the lab
  notebook before handing the plan to Task 3, using these machine-readable keys:

  ```text
  measured_file=relative/path/from/owning/worktree
  measured_worktree=/absolute/path/to/owning/worktree
  ```

- [ ] **Step 3: Run cold and warm measurements**

  Run three fresh Deno processes using the Task 1 loop and its `--summarize`
  command. Then run one benchmark process with
  `--warmup-runs 1 --warm-runs 3 --json-out warm.json`, followed by
  `--summarize warm.json`, documenting exactly which sandbox resources are
  reused. Record median and maximum values for both populations in the lab
  notebook; do not combine cold and warm samples.

- [ ] **Step 4: Commit the attribution evidence**

  ```bash
  git add tests/jupyter_startup_benchmark.ts docs/superpowers/lab-notebooks/2026-08-22-issue-2304-browser-worker.md
  git commit -m "docs: record jupyter startup baseline"
  ```

### Task 3: Optimize the measured dominant path

**Files:**

- Modify: exactly the host/VFS/process-module file identified by Task 2
- Test: the focused benchmark and the existing boot/Python tests
- Modify: `artifacts/pins.json` when the measured implementation is kernel-owned
  and the benchmark root changes

Before Task 3, set `MEASURED_FILE` to the exact implementation path recorded by
Task 2. Keep that variable local to the playground or kernel worktree that owns
the identified file, and set `MEASURED_WORKTREE` to that worktree's absolute
path; do not infer either value from a glob. If the measured file is
kernel-owned, the kernel agent must push its branch, open a PR, and stop for
explicit user authorization before merging. Do not run `gh pr merge` without
that authorization. After the authorized merge, use the merged remote SHA and a
fresh kernel worktree for the benchmark root.

For a playground-owned optimization, initialize the variables explicitly:

```bash
MEASURED_WORKTREE=/Users/sunny/work/yurtos/yurt-playground/.worktrees/issue-2304-completion
# Set MEASURED_FILE to the exact path reported by Task 2 before continuing.
```

Set `MEASURED_FILE` from the durable Task 2 notebook record before running Task
3; do not use a placeholder path or a glob:

```bash
MEASURED_FILE=$(rg -m1 '^measured_file=' docs/superpowers/lab-notebooks/2026-08-22-issue-2304-browser-worker.md | cut -d= -f2-)
MEASURED_WORKTREE=$(rg -m1 '^measured_worktree=' docs/superpowers/lab-notebooks/2026-08-22-issue-2304-browser-worker.md | cut -d= -f2-)
test -n "$MEASURED_FILE"
test -n "$MEASURED_WORKTREE"
```

Set `BENCHMARK_KERNEL_ROOT` to the kernel checkout whose artifact the benchmark
must exercise. Keep the existing verification checkout for a playground-only
optimization; if Task 2 identifies a kernel-owned optimization, set it to that
kernel agent's landed worktree instead:

```bash
BENCHMARK_KERNEL_ROOT=/private/tmp/yurtos-kernel-2354-verify
```

**Interfaces:**

- Consumes: the measured bottleneck and its counters.
- Produces: the same startup behavior with the median and maximum gates met.

- [ ] **Step 1: Write a focused regression for the measured behavior**

  Encode the smallest observable invariant that would regress if the
  optimization were removed, such as a required executable-module cache hit or a
  bounded path-resolution operation count.

- [ ] **Step 2: Run the focused regression red**

  Confirm the test fails against the unoptimized behavior for the expected
  reason.

- [ ] **Step 3: Implement one minimal optimization**

  Change only the measured bottleneck. Before implementation, update this task's
  Files list with the exact resolved path from Task 2. Preserve
  executable/non-executable WASM distinctions and all existing security
  validation.

- [ ] **Step 4: Commit and integrate the optimization before benchmarking**

  Commit the implementation from `MEASURED_WORKTREE`. If it is kernel-owned,
  push the branch, open the kernel PR, stop for explicit user authorization
  before merging, then switch `BENCHMARK_KERNEL_ROOT` to a fresh worktree at the
  merged remote SHA. Do not run `gh pr merge` without authorization.

  ```bash
  cd "$MEASURED_WORKTREE"
  git add "$MEASURED_FILE"
  git commit -m "perf: reduce jupyter cold startup"
  ```

- [ ] **Step 5: Run focused and full checks**

  ```bash
  set -euo pipefail
  if [ "$MEASURED_WORKTREE" != "/Users/sunny/work/yurtos/yurt-playground/.worktrees/issue-2304-completion" ]; then
    artifact_backup=$(mktemp -d)
    restore_artifacts() {
      if [ -f "$artifact_backup/yurt_kernel.wasm" ]; then mv "$artifact_backup/yurt_kernel.wasm" artifacts/; fi
      if [ -f "$artifact_backup/playground.yurtimg" ]; then mv "$artifact_backup/playground.yurtimg" artifacts/; fi
    }
    trap restore_artifacts EXIT
    mv artifacts/yurt_kernel.wasm artifacts/playground.yurtimg "$artifact_backup"/
    BENCHMARK_KERNEL_REV=$(git -C "$BENCHMARK_KERNEL_ROOT" rev-parse HEAD)
    (cd "$BENCHMARK_KERNEL_ROOT" && scripts/build-kernel-wasm.sh)
    test -s "$BENCHMARK_KERNEL_ROOT/target/kernel-wasm/release/yurt_kernel.wasm"
    BENCHMARK_KERNEL_SHA=$(shasum -a 256 "$BENCHMARK_KERNEL_ROOT/target/kernel-wasm/release/yurt_kernel.wasm" | awk '{print $1}')
    test -n "$BENCHMARK_KERNEL_SHA"
    jq --arg rev "$BENCHMARK_KERNEL_REV" --arg sha "$BENCHMARK_KERNEL_SHA" \
      '.kernelWasm.rev = $rev | .kernelWasm.sha256 = $sha' \
      artifacts/pins.json > "$artifact_backup/pins.json"
    mv "$artifact_backup/pins.json" artifacts/pins.json
    YURT_KERNEL_ROOT="$BENCHMARK_KERNEL_ROOT" deno task pin
    trap - EXIT
  fi
  deno fmt --check
  deno lint
  deno check '**/*.ts'
  deno test --allow-all tests/boot_test.ts tests/python_test.ts tests/jupyter_test.ts
  results_dir=$(mktemp -d)
  for run in 1 2 3; do
    YURT_KERNEL_ROOT="$BENCHMARK_KERNEL_ROOT" deno run --allow-all tests/jupyter_startup_benchmark.ts --single-run --run-label "cold-$run" --json-out "$results_dir/cold-$run.json"
  done
  YURT_KERNEL_ROOT="$BENCHMARK_KERNEL_ROOT" deno run --allow-all tests/jupyter_startup_benchmark.ts --summarize "$results_dir"/cold-*.json
  ```

  Expected: all tests pass; median cold startup is at most 60 seconds; no cold
  run exceeds 90 seconds.

- [ ] **Step 6: Commit benchmark and pin evidence**

  The implementation was committed in Step 4. Commit any changed pin and the
  benchmark changes from the playground worktree:

  ```bash
  cd /Users/sunny/work/yurtos/yurt-playground/.worktrees/issue-2304-completion
  if ! git diff --quiet -- artifacts/pins.json; then
    git add artifacts/pins.json
    git commit -m "chore: pin benchmark kernel artifact"
  fi
  git add tests/jupyter_startup_benchmark.ts
  git commit -m "test: measure optimized jupyter startup"
  ```

  Every commit must stage only the exact files recorded by Task 2 or the
  explicitly required pin update; do not stage unrelated worktree changes.
