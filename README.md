# Yurt playground

**Try it: <https://yurt-playground.pages.dev>**

A Linux sandbox that boots inside your browser tab — a BusyBox shell, CPython
3.14 with NumPy, and Jupyter (Notebook and JupyterLab) on a real `ipykernel` —
running on the [Yurt](https://github.com/YurtOS) kernel compiled to WebAssembly.
Nothing runs on a server: the kernel, the filesystem and Python all execute in
the tab, and the page keeps working with the network off.

Where it is going: [the roadmap](docs/ROADMAP.md).

The same playground is also a **desktop app** for macOS and Linux, where the
sandbox runs natively on your machine instead of in the tab: it boots in
seconds, and the guest has real network access. Download links are on the home
page.

## What you get

|                                                              | Browser                                                                       | Desktop app                                                |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Terminal (`ash`), Python 3.14, NumPy, Jupyter Notebook / Lab | ✓                                                                             | ✓                                                          |
| Runs in                                                      | the tab (WebAssembly, no server)                                              | the native Yurt runtime on your machine                    |
| Boot                                                         | ~30–60 s (compiles in the tab)                                                | ~12 s                                                      |
| Network from inside the sandbox                              | none, by design                                                               | yes (Python verifies TLS; BusyBox `wget` does not)         |
| Works offline                                                | yes                                                                           | yes                                                        |
| Needs                                                        | a desktop browser with cross-origin isolation (Chrome, Edge, Firefox, Safari) | any browser to display; nothing to install besides the app |

## Supported packages

The browser page, the desktop app and `yurt run playground` boot the same image
(pinned in `artifacts/pins.json`). It contains:

| Package                   | Version               | For                                                                                                                                           |
| ------------------------- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| BusyBox                   | 1.37.0                | 151 applets, `ash` among them: core utilities, `grep`, `sed`, `awk`, `vi`, `less`, `tar`, `gzip`, `bzip2`, `unzip`, `wget`, `nc`, `ps`, `top` |
| CPython, pip              | 3.14.7, 26.1          | `python3`; `pip`                                                                                                                              |
| NumPy                     | 2.5.0                 | arrays                                                                                                                                        |
| ipykernel, IPython, pyzmq | 7.2.0, 9.13.0, 26.4.0 | the Jupyter kernel behind Notebook and Lab                                                                                                    |

All four are in the image.

### Installing more

The image is becoming modular: a small base image (BusyBox, `git`, `curl`, `jq`,
`sqlite3`, `zsh`, `make`, `perl`, `zstd`, `xz`, CA certificates) with the `pkg`
client and a trusted-repository configuration for
[YurtOS/yurt-packages](https://github.com/YurtOS/yurt-packages), and the heavy
tools as signed packages there. That base image is in progress in
[YurtOS/yurt-ports](https://github.com/YurtOS/yurt-ports); the image pinned here
does not carry `pkg` yet, so nothing can be installed into it today.

- **Desktop app and `yurt run`:** the sandbox has a network, so `pkg update`,
  then `pkg install NAME`, in the terminal. `pip install` of pure-Python
  packages and matching wheels works there already.
- **Browser:** the sandbox has no network, so the page fetches for it. Press
  _Packages_ in the terminal's bar, then _Install_ next to a package; the status
  line shows the download and then `installed NAME`, and the package's command
  runs in the terminal. The page downloads the repository's signed index, the
  package metadata, and the archives with their Sigstore bundles, and lays them
  out in the sandbox as a file-backed copy of the repository. The sandbox's own
  `pkg` then runs `update` and `install` against that copy, trusting the signing
  identity and Sigstore trust root the image configures for the real repository,
  so every check it makes on the desktop (index and archive signatures, every
  sha256 and size the index names, the archive's own metadata) runs unchanged.
  Its rollback protection starts from an empty cache in each session, as on a
  fresh desktop sandbox. `pkg install` typed in the browser terminal still
  fails: only the _Packages_ control can download.
  - Installed packages live in the tab's memory, like every file there, and a
    reload loses them
    ([#81](https://github.com/YurtOS/yurt-playground/issues/81)).
  - A tablet or phone has much less memory for one tab
    ([#200](https://github.com/YurtOS/yurt-playground/issues/200)), so there an
    install whose package archives add up to more than 16 MiB is refused.
    Elsewhere the limit is 256 MiB.

Which packages are published, and which are coming, is tracked in
[YurtOS/yurt-packages](https://github.com/YurtOS/yurt-packages) (its signed
`index.json` is the list) and
[YurtOS/yurt-ports](https://github.com/YurtOS/yurt-ports), not here. The builds
published there today predate the current package format and carry placeholder
signatures, so `pkg` refuses them, in the browser and on the desktop alike,
until they are republished.

## Desktop app

**macOS** (Apple Silicon). Open `Yurt-Playground-aarch64-apple-darwin.dmg` and
drag _Yurt Playground_ to Applications. The app is not notarized yet, so macOS
blocks the first open: allow it under _System Settings → Privacy & Security →
Open Anyway_ (or run
`xattr -dr com.apple.quarantine "/Applications/Yurt
Playground.app"`), then open
it again. A terminal window shows the server; close it to stop.

**Debian / Ubuntu.**
`sudo apt install ./Yurt-Playground-<arch>-unknown-linux-gnu.deb`, then run
`yurt-playground` (or the _Yurt Playground_ desktop entry). Ctrl-C stops it.

Either way the launcher prints `Yurt playground: http://127.0.0.1:<port>/` and
opens it in your default browser. `yurt-playground --port N` fixes the port and
`--no-open` skips the browser (a headless box, a script); `--help` lists them.

Inside the app: the launcher (this repo, compiled with Deno), the site as
deployed, and the native sandbox — `yurt-desktop-host`, the Yurt runtime, the
kernel and the playground image — as pinned in `artifacts/pins.json`. The
launcher starts the host, which boots the image with a public network interface,
your resolvers and a few mapped ports, and relays the terminal and the Jupyter
kernel to the page over WebSockets on the launcher's own origin.

## Driving the sandbox from a program

The page exposes `window.yurt` for a driver -- an agent, a test -- on the hosted
site and in the desktop app alike: `await yurt.ready`, then
`yurt.exec(cmd, { stdin, timeoutMs, maxOutputBytes, cwd, env })` for a result
with `stdout`, `stderr`, `code` or `signal`, `timedOut` and the truncation
flags; `yurt.spawn` for a handle with `wait()` and `kill(signal)`;
`yurt.fs.read/write/list/download`; `yurt.status` and `<html data-yurt-status>`
for "idle", "booting", "running" or "failed". Every command is a process of the
page's own, not a keystroke in the terminal.

`code` and `signal` are the process's wait status, as `waitpid(2)` gives it,
whoever sent the signal: a normal exit is `code` (the exit status) with
`signal: null`; a signal death is `signal` (`"SIGTERM"`, `"SIGKILL"`, ...) with
`code: null`, and `coreDumped` says whether it dumped core. A signal death is
never reported as `code` 128+n -- that is only a shell's convention -- so
`kill -TERM $$` gives `signal: "SIGTERM"`, while a process that catches the
page's SIGINT and exits 130 gives `code: 130`. In the desktop app the host
reports a single number, so there a signal is inferred from the kill the page
sent.

The desktop app also serves the same thing over HTTP for a program on the
machine, on the launcher's loopback port under `/api/`. The token is printed
once (`API token: …`) and left in `~/.yurt/playground.json` (mode 0600) while
the launcher runs (with no `url` in it until the sandbox is up). One launcher
runs per user: a second launch says so, with the URL, and exits. Every request
carries the token as `Authorization: Bearer <token>`:

```sh
T=$(jq -r .apiToken ~/.yurt/playground.json); U=$(jq -r .url ~/.yurt/playground.json)
curl -H "Authorization: Bearer $T" ${U}api/status
ID=$(curl -s -H "Authorization: Bearer $T" -H 'content-type: application/json' \
  -d '{"cmd":"python3 -c \"print(6*7)\"","timeoutMs":60000}' ${U}api/executions | jq -r .id)
curl -H "Authorization: Bearer $T" "${U}api/executions/$ID?wait=1"
curl -H "Authorization: Bearer $T" -X PUT --data-binary @data.csv "${U}api/fs/content?path=/home/user/data.csv"
```

| Route                                                                                         | Does                                                                                              |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `GET /api/status`                                                                             | `{native, status, bootMs, executions: {active, limit}}`                                           |
| `POST /api/executions` `{cmd, stdin?, stdinBase64?, timeoutMs?, maxOutputBytes?, cwd?, env?}` | `201 {id}`; `429` past 16 active                                                                  |
| `GET /api/executions`                                                                         | every execution still held                                                                        |
| `GET /api/executions/{id}`                                                                    | its state; with `?wait=1` the result, read once                                                   |
| `DELETE /api/executions/{id}` `{signal?}`                                                     | signal it (SIGKILL by default)                                                                    |
| `GET` / `PUT /api/fs/content?path=`                                                           | a file's bytes, `application/octet-stream`; `PUT` takes `X-Yurt-Mode: 644` and `X-Yurt-Atomic: 0` |
| `GET /api/fs/entries?path=`                                                                   | `[{name, type, size, mode}]`                                                                      |

Results are JSON, so a command's output is text there; binary output goes
through a file. A process running as you on this machine is you: that is the
whole of the access model. Errors are `{error, code}`; an `Origin` other than
the launcher's own is refused, so no web page can reach it. The page's
`window.yurt` and a `curl` share one registry: at most 16 running or stuck
executions per sandbox, results kept ten minutes or until read.

## How the browser version works

A static page loads `kernel.wasm` and the playground image, boots the kernel in
web workers, spawns `ash` on a host-side PTY that xterm.js talks to, and
launches `ipykernel` inside the sandbox. The Jupyter Notebook and JupyterLab
interfaces are JupyterLite's frontend with one kernel plugin that relays every
message to that real `ipykernel` — none of JupyterLite's own kernels ship, and
no Python runs in the browser itself. The page needs cross-origin isolation
(COOP/COEP headers) for the shared memory the workers use, which is why it is
hosted on Cloudflare Pages; phones are told the sandbox needs a desktop-class
tab.

The "Is this really running in your browser?" section on the home page has
checks you can do yourself, including re-hashing every file the page downloaded
against the published pins.

A second kernelspec, _Python 3 (Yurt, suspend/resume)_, runs one CPython process
built so the sandbox can be sealed (`scripts/build-python-seal.sh`): its
notebook has Suspend and Resume buttons, and a cell that is printing when you
suspend carries on at the same line when you resume, from the image in the
browser's IndexedDB. `src/notebook_kernel_worker.ts` is the whole kernel.

A new release of all of that is one train,
`playground-<YYYY.MM.DD>-<kernel rev>`, cut by `scripts/release-playground.sh`:
it dispatches yurt-sandbox's release workflows from exact commits, generates
`artifacts/pins.json` from what they published, verifies it, and asks before
merging the pin PR that deploys the page. `--validate` builds everything and
publishes nothing; `--pins-only` regenerates the pins from releases cut by hand.

## License

Apache-2.0.
