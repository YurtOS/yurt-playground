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
| Network from inside the sandbox                              | none, by design                                                               | yes (TLS verified)                                         |
| Works offline                                                | yes                                                                           | yes                                                        |
| Needs                                                        | a desktop browser with cross-origin isolation (Chrome, Edge, Firefox, Safari) | any browser to display; nothing to install besides the app |

## Desktop app

**macOS.** Open `Yurt-Playground-<arch>-apple-darwin.dmg` and drag _Yurt
Playground_ to Applications. The app is not notarized yet, so macOS blocks the
first open: allow it under _System Settings → Privacy & Security → Open Anyway_
(or run `xattr -dr com.apple.quarantine "/Applications/Yurt
Playground.app"`),
then open it again. A terminal window shows the server; close it to stop.

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

## License

Apache-2.0.
