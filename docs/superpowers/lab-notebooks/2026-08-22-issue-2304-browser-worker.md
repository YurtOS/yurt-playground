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

## Deno versus Chromium split

`deno test --allow-all tests/boot_test.ts` passes all 6 boot cases in about one
minute, including staged Python execution. The focused Deno result is now green
with the JS host and staging fixes. Chromium acceptance remains separate: it
must consume the published patched kernel artifact rather than the temporary
local source checkout used for this validation.
