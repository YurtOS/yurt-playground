# yurt-playground

In-browser [Yurt](https://github.com/YurtOS) playground. Sibling of
[`yurtos-kernel`](https://github.com/YurtOS/yurtos-kernel),
[`yurt-ports`](https://github.com/YurtOS/yurt-ports), and
[`yurt-jupyter`](https://github.com/YurtOS/yurt-jupyter).

A static page boots a real Yurt sandbox in the tab: first BusyBox/`ash`, then
preinstalled CPython, then the existing `yurt-jupyter` stack with `!` as
ordinary guest `/bin/sh`. The page loads `kernel.wasm` through
`kernel-host-interface-js`. xterm talks to a host-owned PTY. Jupyter JS dials a
port the guest is already listening on. There is no hosted
`yurt-runtime-wasmtime`, no JupyterLite/Pyodide, and no guest egress.

## Status — ash in a tab (Task 4)

Tracking is [#1](https://github.com/YurtOS/yurt-playground/issues/1). This slice
is [#2](https://github.com/YurtOS/yurt-playground/issues/2): load pinned
`kernel.wasm` + `playground.yurtimg`, attach a host PTY, pump it into xterm.

Python and Jupyter are later slices. The image recipe lives in
[`yurt-ports#53`](https://github.com/YurtOS/yurt-ports/pull/53).

Plan:
[`docs/superpowers/plans/2026-08-17-browser-yurt-playground.md`](./docs/superpowers/plans/2026-08-17-browser-yurt-playground.md).

## Run locally

Sibling checkouts, kernel wasm already built, playground image already packaged:

```bash
YURT_KERNEL_ROOT=../yurtos-kernel \
YURT_PORTS_ROOT=../yurt-ports \
  deno task pin
deno task serve
```

Then open `http://127.0.0.1:4173/`. The server sets
`Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp`. GitHub Pages cannot host this.
Reload is a fresh sandbox.

`scripts/pin-artifacts.ts` never rebuilds. It copies matching blobs from
`artifacts/`, sibling checkouts, or `PLAYGROUND_*_URL`, and exits 2 if none
match `artifacts/pins.json`.

## Layout

```
~/work/yurtos/
├── yurtos-kernel/      # kernel.wasm + JS host APIs
├── yurt-ports/         # playground.yurtimg recipe
├── yurt-packages/      # published BusyBox / later CPython
├── yurt-jupyter/       # Jupyter payload
└── yurt-playground/    # this repo — the page
```

```
yurt-playground/
  public/               # static page (Task 4)
  src/                  # boot, terminal, later network/jupyter
  scripts/              # serve.ts, pin-artifacts.ts
  artifacts/pins.json   # git SHA + sha256; blobs gitignored
  tests/                # Playwright + Deno
```

## What this repo does not own

- Kernel syscalls, PTY attach, `dialSandboxPort` — `yurtos-kernel`
- Image composition — `yurt-ports/ports/playground-image`
- Published packages — `yurt-packages`
- The Jupyter site-packages tree — `yurt-jupyter`

## Local gates

```bash
deno fmt --check
deno lint
deno check '**/*.ts'
deno test --no-check --allow-read --allow-write --allow-env --allow-net --allow-run
```

## License

Apache-2.0.
