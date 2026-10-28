# Yurt playground roadmap

The [Yurt playground](https://yurt-playground.pages.dev) is a Linux sandbox that
runs inside a browser tab. A WebAssembly kernel (Yurt) runs BusyBox, CPython,
NumPy, Jupyter, Node.js and Gemini CLI, with nothing running on a server. The
desktop app runs the same sandbox natively, with network access. The idea the
playground demonstrates, and where it is the right tool, is written up in
[Where Yurt works best](https://github.com/YurtOS/yurtos-kernel/blob/main/docs/WHY_YURT.md).

This page says where the playground is going. It is a plan, not a promise: items
move between sections, and some will change shape or be dropped. What has
actually shipped is in the
[release notes](https://yurtos.github.io/yurt-playground/), and what is in
progress right now is in their
[Upcoming](https://yurtos.github.io/yurt-playground/#upcoming) section.

_Last updated 2026-10-28, after train
[playground-2026.10.27-3d32068.2](https://yurtos.github.io/yurt-playground/#playground-2026.10.27-3d32068.2)._

## Now

What you can use today.

- **A Linux shell in the tab.** BusyBox `ash` and 151 applets, with no server
  and no network; the page keeps working offline
  ([first train](https://yurtos.github.io/yurt-playground/#playground-2026.09.21-7eb03a7)).
- **Python and Jupyter.** CPython 3.14, pip and NumPy, and Jupyter Notebook and
  JupyterLab on a real `ipykernel` running inside the sandbox.
- **A slim browser image that installs Python itself.** The tab loads 23.5 MB
  (the shell, the command-line tools, `sudo` and `pkg`) instead of 144 MB, and
  every page that runs Python installs the newest Python set from the signed
  package repository with the sandbox's own `pkg`, the first time it needs it
  ([2026.10.27](https://yurtos.github.io/yurt-playground/#playground-2026.10.27-3d32068)).
- **Instant Python on later visits.** After the first install the browser keeps
  the installed files as one layer, so a reload has Python ready in about 11
  seconds instead of about 85 (measured on the live site), with no package
  downloaded, as long as the repository still offers the same set
  ([2026.10.27.2](https://yurtos.github.io/yurt-playground/#playground-2026.10.27-3d32068.2)).
- **A stalled install offers Try again.** When the install stops making
  progress, the cell says so, and Try again starts a fresh sandbox without
  reloading the page
  ([2026.10.27.2](https://yurtos.github.io/yurt-playground/#playground-2026.10.27-3d32068.2)).
- **Packages, released on their own schedule.** Python, Node, Gemini CLI, Go,
  `gh`, Perl and more are published in
  [YurtOS/yurt-packages](https://github.com/YurtOS/yurt-packages) independently
  of trains ([Packages](https://yurtos.github.io/yurt-playground/#packages)). In
  the browser tab the _Packages_ panel installs them, and the sandbox's own
  `pkg` checks every signature first; a new Python set reaches the page with no
  train
  ([2026.10.26](https://yurtos.github.io/yurt-playground/#playground-2026.10.26-3d32068),
  [2026.10.27](https://yurtos.github.io/yurt-playground/#playground-2026.10.27-3d32068)).
- **Upload files** from your device into the browser sandbox
  ([2026.10.26](https://yurtos.github.io/yurt-playground/#playground-2026.10.26-3d32068)).
- **Desktop app** for macOS (Apple Silicon) and Debian/Ubuntu. The sandbox runs
  natively, boots in seconds and has real network access. Its image is now 91.9
  MB instead of 144.0 MB: the slim image plus the published Python set, Node,
  Gemini CLI and Datasette. The CPython headers and static library moved to the
  new `python-dev` package
  ([2026.10.27.2](https://yurtos.github.io/yurt-playground/#playground-2026.10.27-3d32068.2)).
- **A local agent pane** that runs a model on your GPU through WebGPU, and a
  Stop button for a running cell
  ([2026.09.27](https://yurtos.github.io/yurt-playground/#playground-2026.09.27-a3198c7)).
- **Node.js 22 and Gemini CLI**, as packages in the browser and in the desktop
  app's image; Gemini CLI needs your own API key
  ([2026.10.15](https://yurtos.github.io/yurt-playground/#playground-2026.10.15-230cfe2.2)).
- **Notebook Suspend/Resume.** The _suspend/resume_ notebook kernel saves the
  whole sandbox in the browser, and Resume carries on with the running cell
  where it stopped, even after a page reload
  ([2026.10.20](https://yurtos.github.io/yurt-playground/#playground-2026.10.20-22366ef)).
- **Tablets get the Linux shell**
  ([2026.10.13](https://yurtos.github.io/yurt-playground/#playground-2026.10.13-68259fc)).
- **"Download home"** saves your home directory from the browser sandbox to your
  device.
- **Kernel fixes in most trains**; the latest kernel (2026.10.26) adds bind and
  move mounts, thread-local storage in `dlopen`'d libraries on the desktop host,
  and live shared mappings of `memfd` and `/dev/shm`
  ([2026.10.26](https://yurtos.github.io/yurt-playground/#playground-2026.10.26-3d32068)).

## Next

Planned for the next one or two trains. These are in progress, not finished.

- **Python in Safari.** Why: the first Python install may not finish there. The
  memory error ("memory allocation of … bytes failed") is fixed in `pkg`, but in
  automated Safari runs the sandbox stops answering partway through the install,
  and after five minutes the cell offers Try again. It is tracked with the hang
  a browser debugger causes in Chrome
  ([yurtos-kernel#4170](https://github.com/YurtOS/yurtos-kernel/issues/4170)),
  and it is not yet known whether the automation itself causes it. The shell
  works in Safari.
- **Faster file creation in the guest.** Why: most of the first visit's Python
  install, which takes about a minute, is the sandbox writing the installed
  files
  ([yurtos-kernel#4169](https://github.com/YurtOS/yurtos-kernel/issues/4169)); a
  first step is in review
  ([yurtos-kernel#4195](https://github.com/YurtOS/yurtos-kernel/pull/4195)).
- **Python native extensions loaded from a `.so` at run time**, rather than
  built into Python as NumPy is today. Why: the kernel and libc sides of
  `dlopen` have shipped; a shared `libc.so` is the remaining piece for ordinary
  CPython extension modules to load.
- **Thread-local storage in runtime-loaded libraries in the browser.** Why:
  libraries loaded with `dlopen` that keep per-thread state should behave as
  they do on Linux. The desktop half shipped
  ([2026.10.26](https://yurtos.github.io/yurt-playground/#playground-2026.10.26-3d32068));
  the browser half is in progress.

## Later

Bigger directions. Each needs design work, and the order is not fixed.

- **A current clang as a package.** Go (1.28.0-devel), `gh` (2.102.0) and Perl
  (5.44.0) are now published in
  [YurtOS/yurt-packages](https://github.com/YurtOS/yurt-packages) (see Now); the
  clang build there dates from May 2026 and predates the current package format.
- **Files that survive a reload.** Durable storage for the browser sandbox, so a
  reload does not lose your work
  ([#81](https://github.com/YurtOS/yurt-playground/issues/81)). Saving the whole
  sandbox to a file and restoring it later is a related idea
  ([#8](https://github.com/YurtOS/yurt-playground/issues/8)).
- **Notebook persistence.** Suspend/Resume already keeps a notebook's sandbox in
  the browser; the direction is notebooks and their files that you can close and
  come back to as a matter of course.
- **Open files from your device.** Beyond a one-off upload: opening a file or
  folder from your device in the sandbox and saving changes back. Being
  explored.
- **Go in the browser and on iPad.** Go runs on Yurt as an ordinary Linux
  program, using a port that builds on upstream Go's
  [wasm32 work](https://github.com/golang/go/issues/63131), which is not merged
  upstream yet. The Go toolchain (`go`, `gofmt`) is now a package, `go`, and
  builds and tests programs in a desktop sandbox; it is not in the image. Go
  programs cannot run in the browser sandbox yet: the browser sandbox runs only
  programs that share the one memory it provides, as C, Rust and Python programs
  already do, while Go's linker gives each program a memory of its own, so
  `go version` in the tab fails with "Exec format error". A change to Go's
  linker is in progress. The toolchain is also large: the `go` package is a 59.4
  MB download, unpacked and held entirely in the tab's memory, so it stays an
  opt-in install rather than part of the image. On iPad the per-tab process and
  memory limits are a further question, since `go build` starts several compiler
  and linker processes.
- **More of the playground on tablets.** iPad browsers limit the processes and
  memory one tab can use, which is why tablets get the shell only today and why
  a long shell session can still run out of memory
  ([#200](https://github.com/YurtOS/yurt-playground/issues/200)). The goal is
  for the shell to keep working, then for Jupyter to fit.
- **Ctrl-C for CPU-bound Python.** Ctrl-C and `kill -INT` reaching a Python
  program that is busy computing, so `KeyboardInterrupt` works.
- **A faster JavaScript engine (experimental).** Node on Yurt runs
  SpiderMonkey's interpreter today. A JIT that compiles hot JavaScript to
  WebAssembly inside the sandbox is being measured; it is not in the image and
  stays off by default.
- **More demos**, for example a web server inside the sandbox with an in-page
  preview ([#168](https://github.com/YurtOS/yurt-playground/issues/168)) and
  compiling and running a program inside the sandbox
  ([#172](https://github.com/YurtOS/yurt-playground/issues/172)). The
  [open issues](https://github.com/YurtOS/yurt-playground/issues) list others.

## Known limits today

- **No network inside the browser sandbox**, by design. The page fetches
  packages for it, but `pip install` (pure-Python packages and matching wheels)
  and other downloads from inside the sandbox work only in the desktop app.
- **Installed packages in the browser are lost on reload**, like every other
  file there ([#81](https://github.com/YurtOS/yurt-playground/issues/81)),
  except the Python set, which the browser keeps and writes back on a later
  visit. A tablet or phone refuses installs whose downloads add up to more than
  16 MiB, since one tab there has much less memory
  ([#200](https://github.com/YurtOS/yurt-playground/issues/200)).
- **Files in the browser are kept in memory only.** A page reload starts a fresh
  sandbox and loses everything you wrote, except sandboxes saved by the
  suspend/resume notebook or the snapshot demo. Use "Download home" to keep your
  files.
- **On the desktop**, the root filesystem is also held in memory, and changes to
  it are written to disk at sync points (an explicit `sync`, or when the sandbox
  stops). Host folders you mount are on disk directly.
- **Tablets run the shell only**, with no Jupyter or agent pane. **Phones**
  start no sandbox by default, and the page says why; opened with
  `?start-anyway`, a phone gets the shell and the agent without Python. The
  Notebook and JupyterLab pages do not start a sandbox on a phone
  ([2026.10.27](https://yurtos.github.io/yurt-playground/#playground-2026.10.27-3d32068)).
- **Go is a package, not part of the image**, and Go programs cannot run in the
  browser sandbox yet. In a desktop sandbox they run on one thread, and signals
  reach them only between system calls.
- **Gemini CLI is slow to start the first time in the browser**, after it is
  installed from the _Packages_ panel; it starts faster in the desktop app.
- **The first visit in the browser is slow**: the tab compiles the kernel and
  programs, and installs Python, about 85 seconds to Python ready on a laptop. A
  later visit has Python ready in about 11 seconds.

## How it ships

The playground ships as **trains**, often several a week. A train releases the
kernel, the images, the desktop app and the `yurt` CLI together under one name,
`playground-YYYY.MM.DD-<kernel commit>`, with a `.N` suffix when that name is
already taken; any of them may be unchanged from the previous train. Packages
are released on their own, outside trains
([Packages](https://yurtos.github.io/yurt-playground/#packages)). A train goes
live on the site when it is released.

Each train's notes, including what is not in it and its known issues, are at
<https://yurtos.github.io/yurt-playground/>. Bugs and requests are welcome as
[issues](https://github.com/YurtOS/yurt-playground/issues) in this repository.
