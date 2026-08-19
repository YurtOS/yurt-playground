# Python in the Browser Yurt Playground

## Goal

Extend the merged ash playground so the same sandbox image contains CPython, and
the same host PTY can run both a one-shot Python command and an interactive
Python REPL.

## Scope and ownership

- `yurt-ports` owns composing the existing CPython port output into the
  playground image.
- `yurt-packages` owns publication only if the CPython package is not already
  available to the image recipe.
- `yurt-playground` owns artifact pins, download progress/cache behavior, and
  end-to-end PTY acceptance tests.
- Kernel, Jupyter, guest networking, and notebook UI remain out of scope.

## Design

The image recipe will stage CPython's packaged files under `/usr/local`. The
CPython package's executable is `/usr/local/bin/cpython3.wasm`; the image recipe
will create both `/usr/local/bin/python` and `/usr/local/bin/python3` as image
symlinks to `cpython3.wasm` so ash command lookup and kernel binfmt dispatch
support both conventional command names. The playground's `DEFAULT_ENV` will
explicitly pass `PYTHONHOME=/usr/local` to the initial ash process; Python tests
will verify `python3 -c 'import os; print(os.environ["PYTHONHOME"])'` and
`python -c 'print(2**20)'` as well as the one-shot calculation through
`python3`. The unversioned `python` name is a Python 3 alias; Python 2 is not a
supported or future runtime. The image revision and SHA-256 will be pinned in
the playground only after the composed image is built and exercised.

The browser fetch path will remain fail-closed and same-origin. It will expose
download progress while fetching the larger kernel/image artifacts and use the
Cache API to reuse an exact SHA-256-matching artifact. A cache miss or stale
entry falls back to the network; a hash mismatch is discarded and reported. Deno
tests will use injected fetch/cache implementations so the behavior is
deterministic outside a browser.

The existing `bootPlayground` PTY path remains the single runtime path. The
acceptance harness will boot the real pinned kernel/image, run:

```sh
python3 -c 'print(2**20)'
```

and assert `1048576`, then start `python3`, submit an expression, and assert the
result before stopping the session. The shared harness will gain a
`requireArtifacts` option. Existing ash-only tests may retain their current
developer-friendly skip when no local artifacts exist, but every Task 5 test
will call the harness with `requireArtifacts: true`; artifact resolution, Python
boot, command lookup, `PYTHONHOME`, or REPL failures will reject the test. CI
will set the required artifact roots, so these tests cannot silently skip on a
clean runner.

## Acceptance criteria

1. A fresh image contains `/usr/local/bin/python3` and the runtime uses
   `PYTHONHOME=/usr/local`.
2. The real kernel/PTY integration test prints `1048576` for the one-shot
   command.
3. The real kernel/PTY integration test evaluates an expression in an
   interactive REPL and receives the expected output.
4. Browser artifact loading reports progress and reuses valid cached bytes.
5. Stale or hash-mismatched cached bytes are not used.
6. Existing ash, formatting, lint, type, and CI gates remain green.

## Explicit non-goals

- Jupyter or `dialSandboxPort` guest canaries.
- A second terminal or persistent filesystem.
- Remote runtime execution, Pyodide, or JupyterLite.
- Guest egress.
