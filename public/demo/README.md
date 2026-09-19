# Demo guests

`primes.wasm` is the prime finder from yurt-sandbox's
`tests/fixtures/checkpoint/primes.c` (its `build.sh` has the recipe): built with
Asyncify on `yurt.syscall` and exporting `yurt_asyncify_syscall`, which is what
lets the JS host seal it mid-run for `snapshot.html`. The same binary is what
`yurt run --init /primes.wasm` checkpoints on Linux. Rebuild it there and copy
it here; nothing in this repository generates it.
