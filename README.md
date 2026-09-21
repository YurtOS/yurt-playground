# Yurt playground

**Try it: <https://yurt-playground.pages.dev>**

A Linux sandbox that boots inside your browser tab — a BusyBox shell, CPython
3.14 with NumPy, and Jupyter (Notebook and JupyterLab) on a real `ipykernel` —
running on the [Yurt](https://github.com/YurtOS) kernel compiled to WebAssembly.
Nothing runs on a server: the kernel, the filesystem and Python all execute in
the tab, and the page keeps working with the network off.

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

The desktop app also serves the same thing over HTTP for a program on the
machine, on the launcher's loopback port under `/api/`. The token is printed
once (`API token: …`) and left in `~/.yurt/playground.json` (mode 0600), and
every request carries it as `Authorization: Bearer <token>`:

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
