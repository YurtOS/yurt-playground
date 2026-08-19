# Browser playground compute and snapshots

- **Date:** 2026-08-19
- **Status:** Design approved in chat; implementation pending
- **Related issues:**
  - [yurt-playground#4](https://github.com/YurtOS/yurt-playground/issues/4)
  - [yurt-playground#8](https://github.com/YurtOS/yurt-playground/issues/8)
  - [yurt-ports#56](https://github.com/YurtOS/yurt-ports/issues/56)
  - [yurtos-kernel#2289](https://github.com/YurtOS/yurtos-kernel/issues/2289)
  - [yurtos-kernel#2269](https://github.com/YurtOS/yurtos-kernel/issues/2269)
  - [yurtos-kernel#2304](https://github.com/YurtOS/yurtos-kernel/issues/2304)

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
playground only starts and connects to it. The source is pinned for this arc
to:

- repository: `YurtOS/yurt-jupyter`;
- git revision: `c30f1073c244aab166c67dc3b9b1ff1048def0d4`;
- SHA-256 of the canonical `git archive --format=tar` at that revision:
  `c4290ab8a682b76645fb09b5981255b7615429b757825301088a4e7774b8159d`.

CI checks out that exact revision, verifies the archive hash, stages the
payload through the existing yurt-jupyter packaging script, and passes the
result into the ports image build. The Jupyter entry in `artifacts/pins.json`
is machine-readable and has this shape, with the concrete values above:

```json
"jupyter": {
  "repo": "YurtOS/yurt-jupyter",
  "rev": "c30f1073c244aab166c67dc3b9b1ff1048def0d4",
  "sourceArchiveSha256": "c4290ab8a682b76645fb09b5981255b7615429b757825301088a4e7774b8159d",
  "dependencyLock": "artifacts/jupyter-requirements.lock",
  "dependencyLockSha256": "<64 lowercase hex, populated by pin-artifacts>",
  "materializer": "scripts/materialize-jupyter.ts",
  "materializerSha256": "<64 lowercase hex, populated by pin-artifacts>",
  "hostPython": {
    "implementation": "CPython",
    "version": "3.14.0",
    "architecture": "x86_64",
    "ciProvisioner": "actions/setup-python@v5"
  },
  "normalizedTreeSha256": "<64 lowercase hex, populated by pin-artifacts>",
  "package": "yurt-jupyter-0.1.0-yurt_0.yurtpkg"
}
```

The lock file is checked in and lists every pure-Python dependency with an
exact version, source URL, and SHA-256. `materialize-jupyter.ts` runs under
the exact CPython 3.14.0 x86_64 runtime provisioned by CI. CI must verify
`sys.implementation.name`, `sys.version_info == (3, 14, 0)`, and the expected
architecture before it invokes the materializer; the system `python` is not an
acceptable fallback. The materializer installs with hash checking and no
binary extensions, applies the existing yurt-jupyter exclusions (`zmq`,
`psutil`, compiled files), normalizes ownership/timestamps/order, and emits
the package input tree. The three digest fields above are required pins, not
optional annotations: the implementation PR must replace each schema marker
with a concrete lowercase SHA-256 before changing the image pin. The lock
digest covers the exact lock-file bytes, the materializer digest covers the
exact script bytes, and the normalized-tree digest covers a canonical tar of
the generated tree. `pin-artifacts` and CI fail closed if any field is absent,
not 64 lowercase hex characters, or does not match the checked-in input. The
image pinning step also hashes the final image. A clean runner must never
obtain the payload from an unpinned working tree or an implicit package-manager
install.

The normalized-tree digest uses a repository-owned serializer, not the host's
`tar` command. `scripts/canonical-tree-tar.ts` emits exactly one POSIX USTAR
512-byte header per entry, followed by file data padded to a 512-byte boundary,
and exactly two zero 512-byte end blocks. The serialization rules are:

- entries are relative UTF-8 paths with `/` separators, no leading `/`, and no
  `.` or `..` components; the root entry is omitted;
- entries are sorted by raw UTF-8 path bytes; paths that cannot fit the USTAR
  name and prefix fields are rejected rather than encoded with PAX or GNU
  extensions; directory names have no trailing `/` in the canonical path;
- all numeric fields use NUL-terminated octal ASCII in the POSIX USTAR field
  widths; the checksum field uses six octal digits, NUL, and a trailing space;
- directories use type `5`, mode `0755`, size zero, and an empty link target;
- regular files use type `0`, mode `0755` when any execute bit is present and
  `0644` otherwise, with their exact bytes and no transformation;
- symlinks use type `2`, mode `0777`, size zero, and their exact UTF-8 link
  target in the USTAR link-name field; symlink targets are never followed;
- uid, gid, device numbers, user/group names, and atime/ctime/mtime are zero
  or empty; USTAR magic/version, checksum spacing, and numeric field encoding
  are fixed by the serializer and are not delegated to a platform utility.

The digest is SHA-256 over those emitted bytes. The same serializer and rules
run in local pinning and CI, and the serializer source itself is covered by
`materializerSha256`.

### Jupyter

Real ipykernel execution is gated on yurtos-kernel#2304. That issue must prove
the Worker-backed multi-threaded kernel path with the unchanged yurt-jupyter
payload, including libzmq I/O-thread progress and a host-bridge cell smoke.
Until that gate is green, this arc may verify deterministic payload staging and
import readiness, but it must not claim notebook execution or add a successful
Jupyter acceptance test.

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

Active-session restore is a hard prerequisite, not an assumption of the
playground. Before snapshot UI work begins, yurtos-kernel#2289 must provide a
host-interface contract with all of the following properties:

- an admission/preflight operation validates the complete kernel resource graph
  before capture or restore mutates state;
- the capture response identifies every host-backed resource that must be
  reattached, including the host PTY and guest Jupyter port transports;
- restore accepts a host reattachment table and atomically reconnects those
  resources to restored guest descriptors; and
- any missing or rejected reattachment leaves both kernel and host state
  unchanged and returns a structured error.

The JS host wrapper must expose this contract to the playground as paired
capture/restore operations, rather than making the page call raw wasm exports
or guess how to rebuild a live fd. Until that contract and its kernel/JS tests
exist, the active-session round-trip acceptance tests are blocked and no
snapshot button should be presented as working. A separately scoped
filesystem-only export would be a different feature and is not substituted
silently.

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
4. Ask the host interface to prepare the restored kernel and replacement PTY
   and Jupyter resources while the current transports remain attached.
5. Enter the checkpoint barrier without destroying the current pumps, then
   commit the kernel/resource swap as one host transaction.
6. Only after the commit acknowledgement, atomically hand the terminal and
   notebook clients their replacement transport handles.
7. End the barrier, re-enable controls, and report success.

There is no detach-first path. The current pumps and resource handles remain
the rollback set until the host transaction commits. Any validation,
preparation, barrier, restore, or replacement-transport failure before that
acknowledgement aborts the transaction and resumes the original pumps against
the unchanged sandbox. If a failure occurs after the acknowledgement, the
host contract must provide an atomic rollback to that same rollback set before
the UI reports failure; otherwise the commit operation itself must not expose
success.

If validation, host-resource admission, or restore fails, the current sandbox
must remain usable and the UI must report the failure. In particular, an
active PTY or Jupyter socket may not be silently replaced by a dead or local
stand-in. The implementation must follow the completed kernel contract in
yurtos-kernel#2289.

## Interfaces and ownership

- `src/boot.ts` exposes a session lifecycle sufficient to quiesce and
  transactionally swap terminal/Jupyter clients without creating a second
  sandbox; it retains the old transport set until commit.
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
- Verify a failed restore leaves the original terminal and Jupyter transports
  usable, with the original filesystem and process state unchanged.
- Verify controls are disabled during the transition and re-enabled after both
  success and failure.

## Delivery order

1. Land and verify yurtos-kernel#2304: Worker-backed multi-threaded ipykernel
   and libzmq progress through the browser host. This is a hard gate for real
   notebook execution.
2. Land and verify the kernel/JS host resource-admission and reattachment
   contract required above. This is a hard gate for active-session snapshots.
3. Add the machine-readable Jupyter source/dependency pins and deterministic
   materializer, then update the ports image composition and artifact pins;
   prove NumPy and Jupyter import readiness from a clean build.
4. Refactor the playground boot/session lifecycle around explicit clients and
   quiescence.
5. Add the standard Jupyter client and notebook pane.
6. Add snapshot export/import controls and in-place reconnect.
7. Run focused tests, browser acceptance tests, and all CI gates from a clean
   artifact configuration.
