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

## Status — repo is bootstrapped, page is not built yet

This repository exists so the page, pins, local COOP/COEP server, and Playwright
acceptance have a home. Tracking is
[#1](https://github.com/YurtOS/yurt-playground/issues/1). The first demo (ash in
Chromium) is [#2](https://github.com/YurtOS/yurt-playground/issues/2) and is
blocked on kernel PTY/dial PRs and the `yurt-ports` playground image
([#52](https://github.com/YurtOS/yurt-ports/issues/52)).

Plan:
[`docs/superpowers/plans/2026-08-17-browser-yurt-playground.md`](./docs/superpowers/plans/2026-08-17-browser-yurt-playground.md).

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
deno test --allow-read --allow-env
```

Once Task 4 lands: `deno task serve` on `http://127.0.0.1:4173/` with
`Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp`. GitHub Pages cannot host this.

## License

Apache-2.0.
