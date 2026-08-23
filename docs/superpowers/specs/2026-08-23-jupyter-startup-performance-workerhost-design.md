# Jupyter Startup Performance and Browser WorkerHost Design

## Goal

Reduce the measured cold-start cost of the Deno Jupyter path and fix the
browser-only background-child stall so the unchanged yurt-jupyter payload reaches
the real Chromium acceptance test: `1+1`, NumPy array arithmetic, and clean
shutdown.

## Current evidence

- Deno reaches `IPKernelApp.initialize()` and writes a valid five-port
  connection file in roughly two minutes.
- The same Deno path completes `ssl`, `zmq`, `IPKernelApp` import, and
  `IPKernelApp.initialize()` checkpoints.
- Chromium echoes the launcher and connection-file polling commands but does not
  return the shell prompt or produce the connection file within 240 seconds.
- The JS kernel host installs `WorkerHost` as the production `ThreadHost`; the
  old `CooperativeSerialBackend` explanation is obsolete.
- The current timeout increase is only a guard for a slow successful Deno path;
  it is not the performance fix or the browser fix.

## Track A: startup performance

Instrument the existing Deno harness at phase boundaries rather than changing
the guest payload. Measure:

1. image staging and executable WASM module caching;
2. CPython process startup;
3. `import ssl`;
4. `import zmq`;
5. `from ipykernel.kernelapp import IPKernelApp`;
6. `IPKernelApp.initialize()` and connection-file publication.

Record cold and warm runs. If the dominant cost is guest filesystem traversal,
count the relevant `stat`, `open`, `read`, and path-resolution operations. If the
dominant cost is process-module compilation or Worker startup, measure those
boundaries separately. Optimize only the measured dominant path, preserving the
unchanged yurt-jupyter payload and the shared-VFS contract.

The current observed cold-start baseline is roughly 120 seconds. The measurable
performance target is a median cold-start time of at most 60 seconds and no
individual cold run above 90 seconds, measured over three fresh Deno runs on the
same machine and artifact set. There must be no regression in the existing boot,
Python, or Jupyter protocol tests. If the three-run baseline materially differs
from 120 seconds, record it, but retain the absolute 60/90-second acceptance
gates rather than moving the goalposts.

## Track B: browser WorkerHost correctness

Create a minimal browser reproduction that launches a short-lived background
process and a long-running Python background process through the same PTY. The
reproduction must capture:

- whether the shell receives its prompt after `&`;
- whether the child leader Worker signals ready;
- whether the child publishes its terminal state;
- whether the connection-file polling command is actually dispatched;
- whether WorkerHost relay or job-control state remains pending.

Add the smallest failing regression test in `yurtos-kernel` at the WorkerHost,
process-engine, or shell boundary identified by that trace. Keep the test
browser-realistic: use actual Workers and shared memory where the existing test
infrastructure supports them. Do not replace the child process with a mock or
replace Jupyter networking with a host shortcut.

The browser acceptance boundary is the existing Playwright test using the real
kernel artifact and image. It must observe Jupyter ready, evaluate `1+1`, and
evaluate `import numpy as np; np.array([1, 2]).sum()`. It must then execute an
explicit shutdown phase: send a standard Jupyter shutdown request through the
control transport, await transport closure, terminate the guest session through
the existing session lifecycle, and assert that the guest Jupyter process has
exited before closing the browser and server. The shutdown assertion must be
observable in the test; `browser.close()` and `server.shutdown()` alone do not
prove guest cleanup.

## Ownership and integration

- `yurt-playground` owns instrumentation, timeout policy, browser acceptance,
  and this lab/spec documentation.
- `yurtos-kernel` owns WorkerHost, process lifecycle, relay, and guest-visible
  scheduling/job-control fixes.
- `yurt-jupyter` remains the unchanged payload; its documentation must describe
  WorkerHost-backed threads and the unresolved startup boundary accurately.

No issue is closed and no acceptance claim is made until the real Chromium gate
passes with the published kernel artifact.

## Verification

- Deno formatting, lint, type-check, and focused tests remain green.
- Performance measurements include cold and warm timings with phase labels.
- Three cold runs meet the median <=60-second and maximum <=90-second startup
  gates.
- The new WorkerHost regression is red before the kernel fix and green after it.
- The real Playwright Chromium gate passes Jupyter readiness, NumPy evaluation,
  the explicit guest shutdown assertion, and browser/server teardown.
