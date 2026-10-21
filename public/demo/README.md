# Demo guests

`primes.wasm` is the prime finder from yurt-sandbox's
`tests/fixtures/checkpoint/primes.c`, built with the guest SDK the kernel pin
uses (0.0.29 for kernel 22366efa7) and nothing else:

    source yurtos-kernel/target/yurt-sdk/env.sh
    "$YURT_CC" -O2 primes.c -o primes.wasm

From SDK 0.0.29 on, yurt-cc's own Asyncify pass is the checkpoint
instrumentation (`yurt.host_checkpoint` is a suspend import, `yurt.syscall` is
not), and that is what the JS host requires before it seals a process for
`snapshot.html`. Do not re-run wasm-opt with Asyncify on `yurt.syscall`, the
recipe before 0.0.29: the host refuses that module. A binary from an SDK before
0.0.27 does not start at all (it lacks `__stack_low`/`__stack_high`). Nothing in
this repository generates it; rebuild it whenever the SDK pin moves.

`python3-seal.wasm` (51 MB, not committed) is CPython 3.14 relinked the same way
from the cpython port's build tree. It is pinned in `artifacts/pins.json`
(`pythonSeal`) and installed here by `scripts/install-pinned-artifacts.sh`. The
release train builds it beside the image, from the same cpython build
(yurt-ports `ports/cpython/scripts/build-seal.sh`), and publishes it as
`python-seal-<train>`; `scripts/build-python-seal.sh` runs that builder for a
local one. The dev server and the static build publish it in 20 MiB parts, and
the `yurt-snapshot` JupyterLite kernel runs it with `cell_server.py` as its cell
loop. Without it that kernel reports the missing file at boot; the other kernel
and the rest of the site do not need it.
