# Demo guests

`primes.wasm` is the prime finder from yurt-sandbox's
`tests/fixtures/checkpoint/primes.c` (its `build.sh` has the recipe): built with
Asyncify on `yurt.syscall` and exporting `yurt_asyncify_syscall`, which is what
lets the JS host seal it mid-run for `snapshot.html`. The same binary is what
`yurt run --init /primes.wasm` checkpoints on Linux. Rebuild it there and copy
it here; nothing in this repository generates it.

`python3-seal.wasm` (not committed, 51 MB) is CPython 3.14 relinked the same way
from the cpython port's build tree: `scripts/build-python-seal.sh` writes it
here, the dev server and the static build publish it in 20 MiB parts, and the
`yurt-snapshot` JupyterLite kernel runs it with `cell_server.py` as its cell
loop. Without it that kernel reports the missing file at boot; the other kernel
and the rest of the site do not need it.
