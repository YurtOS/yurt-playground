# Demo guests

`primes.wasm` is yurtos-kernel's `test-fixtures/wasm/seal-primes/primes.c`,
built by that directory's `build.sh`: a prime finder Asyncify-instrumented on
`yurt.syscall` (it exports `yurt_asyncify_syscall`), which is what lets the JS
host seal it mid-run for `snapshot.html`. Rebuild it there and copy it here;
nothing in this repository generates it.
