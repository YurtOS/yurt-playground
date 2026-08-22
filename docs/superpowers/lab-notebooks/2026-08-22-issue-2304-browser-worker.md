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
- Adding host process-module caching as a probe reaches the kernel validator,
  which rejects CPython's exception-handling `try_table` opcode (`0x1f`);
  without the cache, child `exec` reports `not found`. This is a kernel-host
  executable-loading limitation, not an artifact or Chromium-only problem.

## Next experiment

Reproduce the CPython executable-loading failure in the kernel host with the
pinned image, then fix or explicitly extend the kernel module validator/loading
path before returning to browser acceptance.

## Deno versus Chromium split

`deno test --allow-all tests/boot_test.ts` passes all five existing boot cases
in about one minute, but those cases do not execute Python. A focused Deno
command reproduces `/bin/sh: python3: not found`, so the browser failure is
downstream of a shared Deno/Chromium executable-loading gap.
