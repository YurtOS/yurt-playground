# Browser playground compute and snapshots

- **Date:** 2026-08-19
- **Status:** Design approved in chat; implementation pending
- **Related issues:**
  - [yurt-playground#4](https://github.com/YurtOS/yurt-playground/issues/4)
  - [yurt-playground#8](https://github.com/YurtOS/yurt-playground/issues/8)
  - [yurt-ports#56](https://github.com/YurtOS/yurt-ports/issues/56)
  - [yurtos-kernel#2289](https://github.com/YurtOS/yurtos-kernel/issues/2289)
  - [yurtos-kernel#2269](https://github.com/YurtOS/yurtos-kernel/issues/2269)

## Goal

Turn the browser playground into a small, real computational sandbox:

- ash and Python 3 continue to run in the existing terminal;
- NumPy is available from the same Python interpreter;
- the real `yurt-jupyter` payload runs an ipykernel in the guest;
- a notebook pane communicates with that guest kernel through the Yurt port
  bridge; and
- users can download a sandbox snapshot and restore it in place later.

The playground owns the page, host wiring, artifact pins, and acceptance tests.
The kernel owns execution and snapshot semantics. The ports repository owns
image composition. The `yurt-jupyter` repository is consumed unchanged.

## Non-goals

- Do not fork or modify `yurt-jupyter`.
- Do not add guest egress, `Deno.connect`, a host TCP shortcut, or JupyterLite.
- Do not replace the real ipykernel protocol with a fake notebook protocol.
- Do not make snapshots a page-local terminal-history or ad-hoc VFS archive.
- Do not silently skip configured-artifact or integration tests.
- Do not promise restore of resources the kernel host contract cannot reattach.

## Architecture

### Image and Python

The pinned playground image is rebuilt from the ports revision that contains
the existing NumPy extension port. NumPy's compiled modules are baked into
`cpython3.wasm` by the ports pipeline and its Python tree is staged into the
image. The existing Python 3 aliases remain `python` and `python3`; Python 2
is not supported.

The same image stages the versioned pure-Python payload from `yurt-jupyter`.
The payload remains responsible for ipykernel and its Python dependencies; the
playground only starts and connects to it.

### Jupyter

The guest starts the real ipykernel using the image's Python 3 executable. The
page uses the kernel host's `dialSandboxPort` mechanism to reach the guest's
Jupyter transport. Any HTTP, WebSocket, or ZMQ adaptation required by the
existing kernel host is implemented at that host boundary, not by opening a
host operating-system socket from the page.

The page owns a deliberately small notebook surface: cell input, execute,
output, and basic status/error reporting. It is a client of the standard
Jupyter messages, not a replacement for ipykernel. The terminal and notebook
share the same guest VFS and process environment.

### Snapshot lifecycle

The page exposes Save snapshot and Restore snapshot controls above the
terminal. A session controller owns the lifecycle so terminal and Jupyter
clients do not independently race snapshot operations.

Capture:

1. Disable terminal, notebook, and snapshot controls that could mutate state.
2. Enter the kernel checkpoint/quiescence barrier.
3. Request the canonical kernel snapshot envelope.
4. Validate the returned envelope and create a downloadable `.yurtsnapshot`
   `Blob`.
5. End the barrier and restore normal input state.

Restore:

1. Read the selected file into an immutable byte array.
2. Validate its snapshot version and complete resource graph before mutation.
3. Disable terminal, notebook, and snapshot controls.
4. Quiesce or detach current PTY and Jupyter transport pumps.
5. Restore through the kernel host interface transaction.
6. Reattach/reconnect the PTY and Jupyter transports to the restored state.
7. Re-enable controls and report success.

If validation, host-resource admission, or restore fails, the current sandbox
must remain usable and the UI must report the failure. In particular, an
active PTY or Jupyter socket may not be silently replaced by a dead or local
stand-in. The implementation must follow the kernel contract in
yurtos-kernel#2289; if the active session is not restorable, the operation is
rejected clearly until the kernel-side contract supports it.

## Interfaces and ownership

- `src/boot.ts` exposes a session lifecycle sufficient to quiesce, detach, and
  reattach terminal/Jupyter clients without creating a second sandbox.
- A new playground session/controller module coordinates notebook and snapshot
  state transitions.
- `src/jupyter.ts` owns guest kernel startup and the page-side standard Jupyter
  client. It does not contain a second Python/Jupyter implementation.
- A snapshot module owns file validation, download naming, and calls into the
  kernel host's canonical capture/restore methods.
- `public/index.html` supplies controls above the terminal and a notebook pane;
  behavior remains in TypeScript.
- `tests/` contains deterministic unit/controller tests and configured-artifact
  end-to-end tests. Artifact resolution errors are failures, never successful
  skips, when the test is run in the integration configuration.

## Acceptance tests

### Image and Python

- A clean pinned image build completes in CI.
- `python` and `python3` start Python 3.
- `import numpy` succeeds and a real ndarray operation returns the expected
  value.
- `import ipykernel, jupyter_client` succeeds.

### Jupyter and shared VFS

- The guest ipykernel listens and the page dials it through the Yurt host
  bridge.
- A notebook cell evaluates `1 + 1`.
- A notebook cell imports NumPy and performs array arithmetic.
- `!echo hi` returns output from BusyBox.
- A file created in ash is readable from a notebook cell and vice versa.
- The ash prompt remains usable while the notebook is active.

### Snapshot round-trip

- Create a marker file in ash and capture a snapshot.
- Mutate or remove the marker after capture.
- Restore the downloaded snapshot in place.
- Verify the marker through ash and a notebook cell.
- Verify that both PTY and Jupyter connections are live after restore.
- Verify malformed, incompatible, and unreattachable snapshots fail before
  partial mutation.
- Verify controls are disabled during the transition and re-enabled after both
  success and failure.

## Delivery order

1. Confirm the pinned kernel host exposes the required snapshot restore and
   transport reattachment contract; open follow-up kernel work only if the
   existing issues do not cover the concrete gap.
2. Update the ports image composition and pins; prove NumPy and Jupyter import
   readiness from a clean build.
3. Refactor the playground boot/session lifecycle around explicit clients and
   quiescence.
4. Add the standard Jupyter client and notebook pane.
5. Add snapshot export/import controls and in-place reconnect.
6. Run focused tests, browser acceptance tests, and all CI gates from a clean
   artifact configuration.

