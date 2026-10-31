# Yurt playground

A Linux sandbox that runs entirely in your browser tab: a shell, Python and
Jupyter, with nothing running on a server. It runs on Yurt, an original
Linux-compatible kernel written in Rust and compiled to WebAssembly. Yurt is not
Linux itself: it implements the Linux system-call interface, so ordinary Linux
programs (BusyBox, CPython, git), compiled to WebAssembly for it from their
usual sources, run as they would on Linux. The same sandbox also runs natively
on your machine as a desktop app.

What a sandbox in a tab is for: coding environments that need no server per
user, a place to run the tools an AI agent calls, away from your machine,
notebooks that keep working offline, and sandboxes embedded in a product of your
own.

## Try it

**<https://yurt-playground.pages.dev>**: press _Start the sandbox_.

- **Boot.** The page restores a ready-made snapshot of a booted sandbox: a shell
  prompt in about 2 s and Jupyter ready in about 5 s on a desktop (measured in
  Chromium; WebKit, Safari's engine, takes about 8 s to Jupyter).
- **First visit.** A desktop browser downloads about 138 MB once: the 7.2 MB
  kernel and a 131 MB snapshot with Python and Jupyter. A tablet downloads about
  102 MB, a phone about 38 MB. A repeat visit takes them from the browser's
  cache.
- **Phones and tablets boot too**: a phone gets the shell, a tablet the shell
  and Python. Jupyter needs a desktop browser.

The Notebook and JupyterLab links at the top of the page open the full Jupyter
interfaces. What changed in each release is in
[the release notes](https://yurtos.github.io/yurt-playground/); where it is
going, in [the roadmap](docs/ROADMAP.md).

## What works today

|                                    | Browser                                                               | Desktop app                                        |
| ---------------------------------- | --------------------------------------------------------------------- | -------------------------------------------------- |
| Shell (BusyBox `ash`), git, `curl` | ✓                                                                     | ✓                                                  |
| Python 3.14                        | ✓ (not on phones)                                                     | ✓                                                  |
| NumPy                              | ✓ desktop                                                             | ✓                                                  |
| Jupyter Notebook and JupyterLab    | ✓ desktop                                                             | ✓                                                  |
| Node.js 22, Gemini CLI             | as packages (Gemini CLI needs the desktop app's network for its API)  | ✓ in the image                                     |
| Runs in                            | the tab (WebAssembly, no server)                                      | the native Yurt runtime on your machine            |
| Boots                              | the slim image, or a snapshot of it with Python installed             | the full image                                     |
| Network from inside the sandbox    | none, by design                                                       | yes (Python verifies TLS; BusyBox `wget` does not) |
| Works offline                      | yes, after the sandbox is up                                          | yes                                                |
| Needs                              | a browser with cross-origin isolation (Chrome, Edge, Firefox, Safari) | macOS (Apple Silicon) or Debian/Ubuntu             |

In the browser, files live in the tab's memory: a reload starts a fresh sandbox
(_Download home_ saves your home directory first). Planned, not done yet: files
that survive a reload, Python native extensions loaded at run time, Go programs
in the browser, and Jupyter on tablets. The [roadmap](docs/ROADMAP.md) has the
rest.

### What is in the sandbox

The browser boots the **slim image** (23.5 MB): BusyBox 1.37.0 (151 applets,
`ash` among them), `git`, `curl`, `jq`, `sqlite3`, `zsh`, `make`, `zstd`, `xz`,
CA certificates, the `pkg` package client and a passwordless `sudo` for the
default user. By default it restores a snapshot of that image instead of booting
it: on a desktop with the Python set installed, on a tablet with Python alone,
on a phone as it is.

The desktop app and `yurt run playground` boot the **full image** (92 MB): the
slim image plus the Python set, Node.js, Gemini CLI and Datasette.

The Python set is CPython 3.14.7 with pip 26.1, NumPy 2.5.0, and the Jupyter
kernel (`ipykernel` 7.2.0, IPython 9.13.0, pyzmq 26.4.0).

## Help bring Yurt to customers

We're looking for a business partner to help identify customer opportunities,
build relationships, and bring Yurt to market.

Contact [Ofer](https://github.com/ofersa) or [Sunny](https://github.com/smarcd).

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

## Desktop app

The same playground, with the sandbox running natively on your machine instead
of in the tab: it boots in seconds, and the guest has real network access.

**macOS** (Apple Silicon).
[Download the disk image](https://github.com/YurtOS/yurt-playground/releases/latest/download/Yurt-Playground-aarch64-apple-darwin.dmg),
open it and drag _Yurt Playground_ to Applications. The app is not notarized
yet, so macOS blocks the first open: allow it under _System Settings → Privacy &
Security → Open Anyway_ (or run
`xattr -dr com.apple.quarantine "/Applications/Yurt Playground.app"`), then open
it again. A terminal window shows the server; close it to stop.

**Debian / Ubuntu.** Download the package for
[x86_64](https://github.com/YurtOS/yurt-playground/releases/latest/download/Yurt-Playground-x86_64-unknown-linux-gnu.deb)
or
[arm64](https://github.com/YurtOS/yurt-playground/releases/latest/download/Yurt-Playground-aarch64-unknown-linux-gnu.deb),
then `sudo apt install ./Yurt-Playground-<arch>-unknown-linux-gnu.deb` and run
`yurt-playground` (or the _Yurt Playground_ desktop entry). Ctrl-C stops it.

Either way the launcher prints `Yurt playground: http://127.0.0.1:<port>/` and
opens it in your default browser. `yurt-playground --port N` fixes the port and
`--no-open` skips the browser (a headless box, a script); `--help` lists them.

Inside the app: the launcher (this repository, compiled with Deno), the site as
deployed, and the native sandbox (the Yurt desktop host and runtime, the kernel
and the full image) as pinned in `artifacts/pins.json`. The launcher starts the
host, which boots the image with a network interface, your resolvers and a few
mapped ports, and relays the terminal and the Jupyter kernel to the page over
WebSockets on the launcher's own origin.

The home page also offers the `yurt` command line for macOS and Linux, which
runs the same image from a shell the way you would use `docker`.

## How the browser version works

A static page loads the kernel (`kernel.wasm`) and a snapshot or the slim image,
boots the kernel in web workers, spawns `ash` on a host-side PTY that xterm.js
talks to, and launches `ipykernel` inside the sandbox. The Jupyter Notebook and
JupyterLab interfaces are JupyterLite's frontend with one kernel plugin that
relays every message to that real `ipykernel`: none of JupyterLite's own kernels
ship, and no Python runs in the browser itself. The page needs cross-origin
isolation (COOP/COEP headers) for the shared memory the workers use, which is
why it is hosted on Cloudflare Pages.

The "Is this really running in your browser?" section on the home page has
checks you can do yourself, including re-hashing files the page downloaded
against the published pins.

A second kernelspec, _Python 3 (Yurt, suspend/resume)_, runs one CPython process
built so the sandbox can be sealed: its notebook has Suspend and Resume buttons,
and a cell that is printing when you suspend carries on at the same line when
you resume, from the image in the browser's IndexedDB.

## Installing more

Packages are signed and published in
[YurtOS/yurt-packages](https://github.com/YurtOS/yurt-packages); its signed
`index.json` is the list.

- **Desktop app and `yurt run`:** the sandbox has a network, so
  `sudo pkg update`, then `sudo pkg install NAME`, in the terminal. Every `pkg`
  command needs root (it writes its cache and state under system directories),
  which is what the passwordless `sudo` is for. `pip install` of pure-Python
  packages and matching wheels works there too.
- **Browser:** the sandbox has no network, so the page fetches for it. Press
  _Packages_ in the terminal's bar, then _Install_ next to a package. The page
  downloads the signed index, the package and its Sigstore bundle, and the
  sandbox's own `pkg` checks every signature, sha256 and size before it
  installs, exactly as on the desktop. `sudo pkg install` typed in the browser
  terminal fails, since only the page can download.
  - Installed packages live in the tab's memory, like every file there, and a
    reload loses them
    ([#81](https://github.com/YurtOS/yurt-playground/issues/81)), except the
    Python set: it comes back with the snapshot, or, when the page boots the
    slim image, from the layer the browser kept of its first install.
  - A tablet or phone has much less memory for one tab
    ([#200](https://github.com/YurtOS/yurt-playground/issues/200)), so there an
    install whose downloads add up to more than 16 MiB is refused. Elsewhere the
    limit is 256 MiB.

## Downloads, memory and boot times

<!-- snapshot-table:start (scripts/snapshot-table.ts) -->
<!-- deno-fmt-ignore-start -->

Train `playground-2026.10.31-3d32068`. Generated from artifacts/pins.json; `deno run -A scripts/snapshot-table.ts` rewrites it.

| Kind | Restored by | Release | Download | Kernel memory | RAM to restore (peak) | This Linux |
| --- | --- | --- | --- | --- | --- | --- |
| desktop | desktop browser (Mac, PC): `?platform=desktop` | not pinned: boots the image | | | | |
| tablet | tablet (iPad): `?platform=tablet` | not pinned: boots the image | | | | |
| phone | phone (iPhone): `?platform=phone` | not pinned: boots the image | | | | |

<!-- deno-fmt-ignore-end -->
<!-- snapshot-table:end -->

The page picks its platform from the device; `?platform=phone`, `tablet` or
`desktop` overrides it as far as the device can run it, and `?snapshot=0` boots
the slim image instead of restoring a snapshot. Each download comes with the 7.2
MB kernel.

Measured with `scripts/measure-boot.ts` (headless, served locally, so the
download is fast) on 2026-10-29. "RAM to restore" is the peak resident memory of
Chromium's renderer processes while the page restores and starts its shell, the
page itself included.

| Platform                                        | Engine   | Time to a prompt, cold / warm | Jupyter ready |
| ----------------------------------------------- | -------- | ----------------------------- | ------------- |
| phone (iPhone 13)                               | Chromium | 0.96 s / 0.63 s               | none          |
| phone (iPhone 13)                               | WebKit   | 0.74 s / 0.53 s               | none          |
| tablet (iPad Pro 11, iPadOS landscape and mini) | Chromium | 1.48-1.52 s / 1.06-1.07 s     | none          |
| tablet (same three)                             | WebKit   | 1.11-1.15 s / 0.83-0.89 s     | none          |
| desktop                                         | Chromium | 1.88 s / 1.48 s               | 5.2 s / 4.4 s |
| desktop                                         | WebKit   | 1.78 s / 1.43 s               | 8.2 s / 7.9 s |

Booting the slim image instead (`?snapshot=0`, Chromium) gives a prompt at about
1.4 s on every platform; a desktop then installs the Python set and starts
Jupyter, ready at about 88 s.

Maintainers: releasing, previews and snapshot tooling are in
[docs/MAINTAINING.md](docs/MAINTAINING.md).

## License

Yurt's own code (this repository, the kernel, runtime and tooling) is licensed
under Apache-2.0; see [LICENSE](LICENSE). Most of those repositories are not
public yet, and this site and the releases ship them as binaries. The guest SDK
and its runtime libraries, which are linked into programs built for Yurt, are
MIT-licensed. Third-party software in the images keeps its own license.
