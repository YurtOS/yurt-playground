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
`yurt-runtime-wasmtime`, no in-browser Python (Pyodide), and no guest egress.

Two interfaces share that design, chosen from the home page (`/`):

- `terminal.html`: the ash terminal plus a single Jupyter cell.
- `jupyter/`: the Jupyter Notebook and JupyterLab interfaces. This is
  JupyterLite's frontend and browser-side server API with exactly one kernel,
  `yurt` (`jupyterlite/yurt-kernel`), which relays every message to the real
  `ipykernel` in the sandbox through `public/playground-bridge.js`. None of
  JupyterLite's own kernels ship; nothing executes in the browser. Build it with
  `deno task build-lite` (node plus `jupyterlite/requirements.txt`).

Phones are sent to `unsupported.html`: the sandbox needs a desktop-class tab.

## Status — ash in a tab (Task 4)

Tracking is [#1](https://github.com/YurtOS/yurt-playground/issues/1). This slice
is [#2](https://github.com/YurtOS/yurt-playground/issues/2): load pinned
`kernel.wasm` + `playground.yurtimg`, attach a host PTY, pump it into xterm.

Python and Jupyter are later slices. The image recipe lives in
[`yurt-ports#53`](https://github.com/YurtOS/yurt-ports/pull/53).

Plan:
[`docs/superpowers/plans/2026-08-17-browser-yurt-playground.md`](./docs/superpowers/plans/2026-08-17-browser-yurt-playground.md).

## Run locally

A `yurtos-kernel` sibling checkout at the pinned rev (the page's JS host is
imported from it), plus the two published blobs:

```bash
scripts/install-pinned-artifacts.sh   # needs gh access to YurtOS/yurt-packages
deno task pin
deno task build-lite                  # the Jupyter Notebook interface
deno task serve
```

Then open `http://127.0.0.1:4173/`. The server sets
`Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp`. GitHub Pages cannot host this.
Reload is a fresh sandbox.

## Deploy

The GitHub Actions workflow fetches the pinned kernel wasm and playground image,
bundles the static page, and deploys `dist/` to Cloudflare Pages. Cloudflare
Pages is used for the runtime because the playground needs COOP/COEP response
headers; a plain `github.io` site cannot provide them.

Create a Cloudflare Pages project and add these repository secrets:

- `CLOUDFLARE_API_TOKEN` — an API token allowed to deploy the Pages project.
- `CLOUDFLARE_ACCOUNT_ID` — the Cloudflare account containing the project.
- `CLOUDFLARE_PROJECT_NAME` — the Pages project name.

Pushes to `main` and manual workflow runs publish the site. The output directory
is `dist/`; the generated `_headers` file applies the required cross-origin
isolation headers.

To build the same output locally:

```bash
scripts/install-pinned-artifacts.sh
deno task pin
deno task build-lite
deno task build-static
```

Neither blob is rebuilt by a consumer: the kernel wasm is deterministic on a
host but not across hosts, and the image needs the guest toolchain plus hours of
port builds. Each is published once to `YurtOS/yurt-packages` (the `release` tag
in `artifacts/pins.json`) and fetched. To move a pin, publish the new blob and
record the sha256 it carries. `scripts/pin-artifacts.ts` only verifies: it
accepts matching blobs from `artifacts/`, sibling checkouts, or
`PLAYGROUND_*_URL`, and exits 2 if none match `artifacts/pins.json`.

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
