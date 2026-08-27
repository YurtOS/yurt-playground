# Issue #2304 browser Worker lab notebook

## Acceptance contract

The real browser path must boot the pinned image through a Worker-hosted kernel,
run Jupyter, evaluate `1+1` and NumPy array arithmetic, and shut down cleanly.

## Verified baseline

- Kernel revision: `9c205ec7d7b37bc7bdc92912e7b230788fb7a3f4` (merged #2354).
- Kernel wasm sha256:
  `99374d14da39829ed2c5688fbcad989281451ef1d95060cd75fae960331cdf7f`.
- Deno WorkerHost suite: 48 passed, 0 failed.
- Playground focused checks: format, lint, type-check, and 5 layout tests pass.
- Deno boot integration tests: 5 passed, 0 failed, including ash command
  execution, fresh second boot, and command-history behavior.
- Branch has the two existing commits updating the kernel pin and browser Worker
  bootstrap URL materialization; no new fix is committed here.

## Browser reproduction

Command:

```text
YURT_KERNEL_ROOT=/private/tmp/yurtos-kernel-2354-verify deno run --allow-all tests/playground_e2e.ts
```

Observed status:

```text
Jupyter did not become ready: status=Jupyter connection file was not printed notebook=starting Jupyter
```

The shell echoes the submitted Jupyter launch and polling commands, but never
prints a prompt, connection file, or readiness marker.

## Trace facts

The root Worker reaches and completes these relayed startup operations:

1. `set_tid_address` (`218`) returns `2` to wasm.
2. `SIGNAL_POLL` (`0x100ce`) is relayed.
3. `SYS_THREAD` self (`0x101e3`, op `3`) returns TID `2`.

The runtime-link gate is open, the mailbox transitions back to `IDLE`, and the
guest syscall wrapper returns to wasm. After that point the Worker emits no
further syscall and no trap/error event, while PTY input does not wake a parked
thread. This places the remaining failure after root Worker startup and before
normal shell I/O, rather than in the original #2341/#2354 admission race.

## Discarded hypotheses

- The pinned kernel artifact is not the old pre-#2354 build; its revision and
  digest were rebuilt and verified.
- The generic structured relay reply is not malformed: the guest receives
  `rc=2`, transitions `REPLIED -> IDLE`, and re-enters the open runtime-link
  gate.
- The focused Deno suite is not evidence of browser acceptance; it does not
  exercise this root Worker plus real PTY sequence.
- Chromium shell smoke succeeds for `echo`, but reports both `python3` and
  `python` as `not found` from the pinned image.
- The same Python failure reproduces through Deno and the CLI runner.
- Tar inspection shows `/usr/local/bin/cpython3.wasm`, `python`, and `python3`
  are present, executable, and each is a 31,046,535-byte WASM image.
- Adding host process-module caching as a probe reaches the JS host's
  hand-written `validateNoDirectMemoryGrow()` scanner, which rejects CPython's
  exception-handling `try_table` opcode (`0x1f`); without the cache, child
  `exec` reports `not found`. Rust/Wasmtime already enables exception handling,
  so this is a JS scanner/parser bug, not a kernel-wide EH limitation.

## Result of the next experiment

The JS host scanner now parses the standardized exception-handling instructions
used by CPython, including `try_table`, and has a focused regression test. The
WASM rewriter also now appends large sections without spreading them onto the JS
call stack. Playground staging caches executable WASM entries, matching the
kernel runner's process-module path without treating non-executable WASM object
files as processes.

With those changes, the focused Deno Python command prints `123`, and the full
playground boot suite passes 6/6. This confirms the runtime and toolchain
already support WASM exception handling; the failure was in JS host
validation/loading.

The remaining acceptance step is still real Chromium with the patched kernel
checkout and pinned image, including Jupyter/NumPy and clean shutdown.

## Current browser blocker

The real Chromium run reaches `starting Jupyter`, but the launch command does
not return to `ash`. The same result occurs in Deno with
`python3 -m ipykernel_launcher`, including with stdin detached and all output
redirected. `sleep 3 &` and `import ipykernel` both work, isolating the hang to
the long-running libzmq startup path.

The earlier `CooperativeSerialBackend` explanation is stale and must not be used
as the current diagnosis: the pinned kernel's JS host installs `WorkerHost` as
the production `ThreadHost`, backed by real Workers. The remaining failure needs
a WorkerHost-specific trace of the Jupyter startup path, including the libzmq
worker's spawn, relay, and socket progress.

The Deno equivalent now reaches `IPKernelApp.initialize()` and writes a valid
connection file with five TCP ports after roughly two minutes of startup. The
playground readiness budget was raised accordingly to 200 seconds, and the
Chromium gate to 240 seconds. Chromium still fails: its PTY shows the launcher
and connection-file polling commands echoed, but no shell prompt, connection
file, or Jupyter output. This is now a browser WorkerHost async child-process /
job-control boundary, not a missing EH implementation, missing Worker Threads,
or merely a short readiness timeout.

## Deno versus Chromium split

`deno test --allow-all tests/boot_test.ts` passes all 6 boot cases in about one
minute, including staged Python execution. The focused Deno result is now green
with the JS host and staging fixes. Chromium acceptance remains separate: it
must consume the published patched kernel artifact rather than the temporary
local source checkout used for this validation. The current Jupyter startup
failure is unresolved; it is not evidence that the kernel lacks Worker Threads.

## 2026-08-23 execution evidence

- The startup probe reached the real pinned image path. It measured `ssl` at 0
  ms, `zmq` at roughly 5–9 s, and the `ipykernel` import checkpoint at roughly
  63–64 s. `IPKernelApp` did not emit the initialization checkpoint on the
  `d57e90c` verification checkout, so the probe remains intentionally red at
  that boundary.
- The payload does not provide `IPKernelApp.shutdown()`. The probe uses the
  actual `app.kernel.do_shutdown(False)` hook and exits explicitly after the
  marker; it does not claim socket teardown until the full Jupyter acceptance
  gate observes it.
- The tightened Chromium shell-only reproduction passed against
  `d57e90cefa08affea6def27ce3e8f22c93b9a575`: both background markers,
  post-marker prompts, and `PYTHON_READY` were observed. This checkout no longer
  reproduces the shell-only WorkerHost stall.
- The real Chromium Jupyter gate still failed after 240 s with no connection
  file. The remaining next-phase target is the Jupyter initialization/launch
  path, not a generic WorkerHost background-child prompt failure.

## 2026-08-27 pairing evidence: the guest cannot exec a child

Three configurations, one image (`playground.yurtimg` built locally 2026-08-27
08:11, sha256 `4f34b46c…` — _not_ the pinned `5d87601b…`):

1. kernel `main` (`a95c8571b`) wasm + `main` JS host,
2. kernel `9c205ec7d` wasm (this branch's pin) + `main` JS host,
3. kernel `9c205ec7d` wasm + `9c205ec7d` JS host, via a scratch copy of this
   repo whose `deno.json` points at a worktree of that revision.

All three fail identically, so **neither the pinned kernel wasm nor the pinned
JS host is the variable**.

The failure is child-process execution, not boot:

- `deno test tests/boot_test.ts` — `echo hi` (a shell builtin) returns its
  marker; `uname` (an exec of the busybox applet) never does and times out at 10
  s, failing `ash session: login, owners, redirects, and touch` and
  `a second ash boot is a fresh sandbox` at 13 s each.
- `ash consumes Up-arrow as command history` passes in 3 s — it exercises line
  editing and never execs.
- `tests/python_test.ts` — both cases fail at ~63 s waiting for the Python
  prompt, which is the same exec path.
- Chromium (`tests/playground_e2e.ts`) fails harder and earlier:
  `kernel_spawn_process failed: rc=-5` with an empty terminal and no console
  output. `notebook-status: starting Jupyter` in that failure is the literal
  default `mountNotebook` sets at mount; it is not evidence that Jupyter began.

Two facts that block re-deriving the 2026-08-23 green Deno result:

- `d57e90cefa08affea6def27ce3e8f22c93b9a575`, the checkout that produced it,
  **does not exist in `yurtos-kernel`** — `git log` reports `bad object`. The
  validation cannot be reproduced from published history.
- Kernel wasm builds are **not byte-reproducible across machines**. Rebuilding
  `9c205ec7d` here yields sha256 `f43bd3d6…`, while `artifacts/pins.json`
  records `99374d14…` for that same commit. Since `pin-artifacts.ts` verifies
  the sha and exits 2 on a mismatch, a locally rebuilt artifact can never
  satisfy a pin recorded elsewhere — an image or wasm has to travel as a blob,
  not as a build recipe.

Next discriminator, not yet run: rebuild `playground.yurtimg` from `yurt-ports`
at the pinned `f0fd628` with today's guest toolchain and repeat configuration 1.
If exec still hangs, the regression is in the guest toolchain or the kernel's
spawn path rather than in this image; if it passes, this image is stale and the
gate needs a blob it can trust.
