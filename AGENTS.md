# Agent Instructions — yurt-playground

Org-wide rules: read [`docs/agents/org.md`](./docs/agents/org.md) first; this
file adds what is specific to this repository. `CLAUDE.md` points here.

## Purpose and layout

The Yurt playground: a static page that boots a real Yurt sandbox (BusyBox
`ash`, CPython with NumPy, Jupyter Notebook/Lab on a real `ipykernel`) in the
browser tab, plus a desktop app that runs the same site against the native
sandbox. Deployed to Cloudflare Pages on every merge to `main`.

This repo owns the page and its workers (`src/`), the local COOP/COEP server
(`scripts/serve.ts`), the JupyterLite front end and its `yurt` kernel plugin
(`jupyterlite/`, npm + `tsc`), compute snapshots, the local LLM agent pane
(`src/agent*.ts`, `src/llm*.ts`), the desktop launcher and installers
(`src/desktop*.ts`, `scripts/build-desktop.sh`), artifact pins
(`artifacts/pins.json`), and browser acceptance. It does **not** own the kernel,
guest toolchain, image recipes, native host, or Jupyter payload.

- Languages: TypeScript on Deno (`deno.json`); the JupyterLite plugin is
  TypeScript built with npm/`tsc`; release and install scripts are bash.
- Tests: unit and integration tests are `tests/*_test.ts` (`deno test`). Browser
  acceptance is `tests/*_e2e.ts`: plain scripts that drive Chromium through the
  `playwright` npm package, run with `deno run` (there is no Playwright test
  runner).
- Plans and specs: `docs/superpowers/plans/`, `docs/superpowers/specs/`.

### Sibling repos (do not reimplement here)

Check these out next to this repo (`../<name>`). Scripts read the env var shown,
defaulting to the sibling path.

| Repo                                                              | What it owns                                                                           | Env var             |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------- |
| [`YurtOS/yurtos-kernel`](https://github.com/YurtOS/yurtos-kernel) | Kernel source and JS host (`@yurt/*` imports resolve into this checkout)               | `YURT_KERNEL_ROOT`  |
| [`YurtOS/yurt-sandbox`](https://github.com/YurtOS/yurt-sandbox)   | Releases of the kernel wasm, the desktop host and the `yurt` CLI                       | `YURT_SANDBOX_ROOT` |
| [`YurtOS/yurt-ports`](https://github.com/YurtOS/yurt-ports)       | `playground-image` recipe and releases (`playground.yurtimg`, sealable CPython)        | `YURT_PORTS_ROOT`   |
| [`YurtOS/yurt-jupyter`](https://github.com/YurtOS/yurt-jupyter)   | Jupyter ipykernel payload source (rev pinned in `artifacts/jupyter-requirements.lock`) | `YURT_JUPYTER_ROOT` |
| [`YurtOS/yurt-packages`](https://github.com/YurtOS/yurt-packages) | Jupyter payload releases; default release repo for a pin that names no `releaseRepo`   | —                   |

Kernel primitives stay in `yurtos-kernel`; image composition stays in
`yurt-ports`. Do not vendor kernel source or port scripts here.

## Build

- `deno task serve` — bundle the page and serve it locally with COOP/COEP.
- `deno task build-static` — the deployable site (what acceptance boots).
- `deno task build-lite` (`jupyterlite/build.sh`) — the JupyterLite site into
  `public/jupyter` (needs python3 and node/npm).
- `deno task build-desktop` — the desktop installers.
- `deno task pin` — resolve the kernel wasm and image against
  `artifacts/pins.json` (fails on a missing or mismatched blob).

## Verification

The full local gate is what CI's `ci.yml` runs on a pull request. Required
hosted checks on `main` (ruleset `main`): **`fmt / lint`** and
**`integration (cross-repo)`**. `integration (cross-repo)` aggregates the
`tests (python|guest|fast)` and five `acceptance (<scene>)` jobs. It also passes
when `KERNEL_CHECKOUT_TOKEN` is absent (a fork PR) with every cross-repo leg
skipped; that is not coverage. A PR is verified only when those legs actually
ran and passed.

**Prerequisites.** Deno **2.7.14** exactly (CI pins it; other 2.x versions
format differently), `gh` authenticated with read access to the private siblings
and their releases, `jq`, `shasum`, Python **3.14.0** (the Jupyter payload tree
hash is only reproducible from that interpreter), node 24 + npm, and
`pre-commit`. Sibling checkouts: `../yurtos-kernel` at
`pins.json .kernelWasm.rev` and `../yurt-jupyter` at
`jupyter-requirements.lock .yurtJupyterRev`.

**Inputs** (once, and again whenever a pin or the lock changes; mirrors
`.github/actions/site-inputs`):

```sh
scripts/install-hooks.sh
YURT_JUPYTER_ROOT=../yurt-jupyter scripts/install-jupyter-payload.sh
HOST_PYTHON=python3.14 YURT_JUPYTER_ROOT=../yurt-jupyter \
  deno run --allow-read --allow-write --allow-env --allow-run scripts/materialize-jupyter.ts
jupyterlite/build.sh
scripts/install-pinned-artifacts.sh
YURT_KERNEL_ROOT=../yurtos-kernel deno task pin
deno run --allow-all node_modules/playwright/cli.js install chromium
```

**Gate:**

```sh
export YURT_KERNEL_ROOT=../yurtos-kernel PLAYGROUND_REQUIRE_ARTIFACTS=1
deno fmt --check
deno lint
deno check "**/*.ts"
deno task test
deno task build-static
deno run --allow-all tests/playground_e2e.ts
deno run --allow-all tests/jupyterlite_e2e.ts
deno run --allow-all tests/snapshot_e2e.ts
deno run --allow-all tests/notebook_snapshot_e2e.ts
deno run --allow-all tests/agent_e2e.ts
```

Each command must exit 0. `deno task test` runs the whole suite CI splits into
shards (`scripts/ci-shards.ts`); the five scripts are the `acceptance (<scene>)`
jobs. With `PLAYGROUND_REQUIRE_ARTIFACTS=1` the artifact-backed tests fail
rather than skip when blobs are missing, which is the point. The hooks are a
subset: pre-commit runs fmt, lint, `deno check` and the tests that need no
blobs; pre-push bundles the page. The hooks skip `deno check` and the bundle
when `../yurtos-kernel` is absent, so a passing hook is not the gate.

## Repository-specific rules

- In-browser. Not a websocket to a native `yurt-runtime-wasmtime` (the desktop
  app is the separate native path).
- One sandbox, one VFS. xterm talks to a host-owned PTY.
- Jupyter JS dials a port the guest is already listening on (`dialSandboxPort`).
  No `Deno.connect`, no host OS TCP, no guest egress in the browser.
- The Notebook/Lab interface is JupyterLite's frontend and server shim with one
  kernel, `yurt`, relaying to the guest `ipykernel`. JupyterLite's own kernels
  (Pyodide, xeus) never ship: the kernel is not replaced, only fronted.
- GitHub Pages cannot set COOP/COEP. Local `scripts/serve.ts` and Cloudflare
  Pages can.
- No framework, bundler, or state-management layer where a module and the DOM
  will do. Prefer a direct call into the kernel's JS host over a wrapper of our
  own.
- A silent `catch` that hides a broken boot is worse than a loud failure.
- Imports: prefer JSR / `node:`-prefixed standard modules; extend the import map
  in `deno.json`.
- Comments are short and explain non-obvious constraints, not change history.

## Pins and releases

- `artifacts/pins.json` records, per artifact (`kernelWasm`, `image`,
  `desktopHost`, `yurtCli`, `pythonSeal`): source repo and git rev, the release
  repo and tag that published it, the build script, and sha256 (keyed per target
  for the desktop host and CLI). `train` names the release train they belong to.
- Blobs (`artifacts/*.wasm`, `*.yurtimg`, `*.yurtpkg`, the materialized Jupyter
  payload, `public/demo/python3-seal.wasm`) are gitignored. Never commit them;
  fetch them with the install scripts, which verify sha256 and never fall back.
- `scripts/release-playground.sh` cuts a release train: it dispatches the builds
  in yurt-sandbox and yurt-ports, regenerates `pins.json` from their releases,
  opens the pin PR, and asks before merging (the merge deploys the page).
  `release-desktop.yml` then builds the installers from the merge commit.
- The Jupyter payload is not reproducible: change
  `artifacts/jupyter-requirements.lock`, run `regenerate-jupyter-payload.yml`,
  publish the result to yurt-packages, and record `payloadTreeSha256`.

## Gotchas

- `tests/layout_test.ts` asserts parts of `ci.yml` (shard list, the `deno check`
  step's shard, `PLAYGROUND_REQUIRE_ARTIFACTS`). Change the workflow and
  `scripts/ci-shards.ts` together.
- `deno check` and the bundle resolve `@yurt/*` into `../yurtos-kernel`. A
  sibling checkout at a rev other than the pinned one can pass or fail locally
  for reasons CI will not reproduce.
- `tests/agent_webgpu_e2e.ts` runs in no workflow (it needs a real GPU; run it
  on a Mac when touching the model path). `tests/desktop_e2e.ts` runs only in
  `release-desktop.yml`, not on PRs; run it by hand when touching the desktop
  app.
