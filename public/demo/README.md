# Demo guests

`primes.wasm` is the prime finder from yurt-sandbox's
`tests/fixtures/checkpoint/primes.c` (its `build.sh` has the recipe): built with
Asyncify on `yurt.syscall` and exporting `yurt_asyncify_syscall`, which is what
lets the JS host seal it mid-run for `snapshot.html`. The same binary is what
`yurt run --init /primes.wasm` checkpoints on Linux. Rebuild it there and copy
it here; nothing in this repository generates it.

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

`datasette_seed.py` creates twelve deterministic orders under
`/home/user/demos/datasette/`. The playground publishes and stages this script;
ports supplies Datasette and SQLite. Initial seeding preserves an existing
`orders.db`; `--reset` restores the sample and removes only its known sidecars,
pid and log. It does not remove other files in that directory.

## Website preview

In the browser playground, **Start preview** serves your files from
`/home/user/demos/preview/site/` through the guest's stdlib Python WSGI server
on port 8002. Edit files in the terminal and refresh the preview frame. Restart
preserves edits; **Reset** restores the sample `index.html` and `app.js`.

Use external `.js` files: inline scripts and event handlers are blocked. The
sample name form demonstrates POST, cookies and redirects. Cookies stay in a
per-session bridge jar, are invisible to `document.cookie`, and are cleared on
Stop or Reset. Open pages inside the preview panel; direct top-level navigation
is refused. Streaming and WebSockets are not supported.

Preview runs user-owned files with the same trust as the terminal. Datasette
remains separately gated on its qualified kernel/image pins.
