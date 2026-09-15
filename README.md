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
isolation headers and a Content Security Policy (`src/csp.ts`). The policy keeps
every request the browser makes from a playground page on the site's own origin,
so "nothing leaves the page" is enforced, not just true of the guest. The
JupyterLite pages additionally get `'unsafe-eval'` (JupyterLab compiles its
settings schemas with `new Function`), and each page's inline scripts are
allowed by hash, derived from the built files. The browser acceptance tests fail
on any policy violation Chromium reports, so a directive that is too tight shows
up there.

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

## Desktop app (macOS, Linux)

The playground on your own machine, with the sandbox running **natively** on
`yurt-runtime-wasmtime` instead of inside the tab: it boots in about 12 s,
Jupyter is ready a few seconds later, and the guest has real network access (TLS
verified against the bundled CA store). The browser is only the display.

**Install.** From the home page's download links (a GitHub release):

- macOS: open `Yurt-Playground-<arch>-apple-darwin.dmg`, drag _Yurt Playground_
  to Applications. It is not notarized, so the first open is blocked; allow it
  under _System Settings → Privacy & Security → Open Anyway_ (or
  `xattr -dr com.apple.quarantine "/Applications/Yurt Playground.app"`) and open
  it again. A terminal window opens with the server; close it to stop.
- Debian/Ubuntu:
  `sudo apt install ./Yurt-Playground-<arch>-unknown-linux-gnu.deb`, then
  `yurt-playground` from a terminal (or the _Yurt Playground_ desktop entry).
  Ctrl-C stops it.

Either way the launcher prints `Yurt playground: http://127.0.0.1:<port>/` and
opens it in the default browser — any browser: native mode needs no cross-origin
isolation. The page is the hosted playground: the ash terminal, the single
Jupyter cell, Jupyter Notebook and JupyterLab.

**What is inside.**

```
Yurt Playground.app/Contents/Resources   or   /usr/lib/yurt-playground
├── yurt-playground        the launcher (this repo, compiled with deno)
├── dist/                  the site, as deployed, minus the in-tab blobs
└── runtime/               the native sandbox, pinned in artifacts/pins.json
    ├── yurt-desktop-host      the sidecar: boots the image, relays a PTY and
    │                          the kernel ports over WebSockets (private repo)
    ├── yurt-runtime-wasmtime  the runtime, built at the kernel wasm's rev
    ├── yurt_kernel.wasm
    └── playground.yurtimg
```

`GET /desktop.json` is how the page knows it is in the app (`src/native.ts` then
talks to `/ws/tty` and `/ws/port/<n>` instead of booting a kernel in a worker).
What the sidecar does is `docker run`, shaped for this image: the image is the
same `playground.yurtimg` the site boots in the tab, built from the port stages
by `yurt-ports/ports/playground-image` (BusyBox init + `inittab`, the session
broker, a CA bundle); it is started with an environment (`PATH`, `PYTHONHOME`,
`HOME`…), a public network interface and the host's resolvers, and five free
loopback ports mapped into the guest for ipykernel. The runtime's protocol stays
inside the sidecar; this repo sees two WebSocket endpoints, documented in the
sandbox repo's `docs/desktop-host-api.md`.

**Build it here.**

```bash
scripts/install-pinned-artifacts.sh          # kernel wasm + image → artifacts/
scripts/install-desktop-host.sh              # host + runtime → runtime/<this target>/
deno task build-static
deno task build-desktop                      # --target for another; needs its runtime/<target>/
open "dist-desktop/$(deno eval 'console.log(Deno.build.target)')/Yurt Playground.app"
deno run --allow-all tests/desktop_e2e.ts    # the built app: native boot, a cell, HTTPS from the guest
deno run --allow-read --allow-net --allow-run scripts/desktop.ts   # from the checkout, no bundle
```

CI's `desktop` job builds both architectures of each OS from the `dist/` the
integration job produced and the pinned runtime, runs `tests/desktop_e2e.ts` on
the runner's own (and installs the `.deb` on Linux), and a merge to `main`
publishes the installers as a GitHub release, which the home page links through
`releases/latest/download/`.

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
