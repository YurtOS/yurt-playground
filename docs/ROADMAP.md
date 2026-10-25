# Yurt playground roadmap

The [Yurt playground](https://yurt-playground.pages.dev) is a Linux sandbox that
runs inside a browser tab. A WebAssembly kernel (Yurt) runs BusyBox, CPython,
NumPy, Jupyter, Node.js and Gemini CLI, with nothing running on a server. The
desktop app runs the same sandbox natively, with network access.

This page says where the playground is going. It is a plan, not a promise: items
move between sections, and some will change shape or be dropped. What has
actually shipped is in the
[release notes](https://yurtos.github.io/yurt-playground/), and what is in
progress right now is in their
[Upcoming](https://yurtos.github.io/yurt-playground/#upcoming) section.

_Last updated 2026-10-25, after train
[playground-2026.10.25-f884f16](https://yurtos.github.io/yurt-playground/#playground-2026.10.25-f884f16)._

## Now

What you can use today.

- **A Linux shell in the tab.** BusyBox `ash` and 151 applets, with no server
  and no network; the page keeps working offline
  ([first train](https://yurtos.github.io/yurt-playground/#playground-2026.09.21-7eb03a7)).
- **Python and Jupyter.** CPython 3.14, pip and NumPy, and Jupyter Notebook and
  JupyterLab on a real `ipykernel` running inside the sandbox.
- **Desktop app** for macOS (Apple Silicon) and Debian/Ubuntu. The sandbox runs
  natively, boots in seconds and has real network access.
- **A local agent pane** that runs a model on your GPU through WebGPU, and a
  Stop button for a running cell
  ([2026.09.27](https://yurtos.github.io/yurt-playground/#playground-2026.09.27-a3198c7)).
- **Node.js 22 and Gemini CLI** in the image; Gemini CLI needs your own API key
  ([2026.10.15](https://yurtos.github.io/yurt-playground/#playground-2026.10.15-230cfe2.2)).
- **Notebook Suspend/Resume.** The _suspend/resume_ notebook kernel saves the
  whole sandbox in the browser, and Resume carries on with the running cell
  where it stopped, even after a page reload
  ([2026.10.20](https://yurtos.github.io/yurt-playground/#playground-2026.10.20-22366ef)).
- **Tablets get the Linux shell**
  ([2026.10.13](https://yurtos.github.io/yurt-playground/#playground-2026.10.13-68259fc)).
- **"Download home"** saves your home directory from the browser sandbox to your
  device.
- **Steady kernel fixes** in every train; the latest makes `epoll` work on
  standard input and output, writes shared file mappings back reliably and
  rebuilds `python3` as a plain Linux/musl CPython
  ([2026.10.25](https://yurtos.github.io/yurt-playground/#playground-2026.10.25-f884f16)).

## Next

Planned for the next one or two trains. These are in progress, not finished.

- **Upload files into the browser sandbox.** Why: today you can download your
  home directory but not bring your own files or data in. In review as
  [#230](https://github.com/YurtOS/yurt-playground/pull/230).
- **Python native extensions loaded at run time.** Why: the kernel side of
  `dlopen` has shipped; a shared C library is the remaining piece for ordinary
  CPython extension modules to load.
- **Thread-local storage in runtime-loaded libraries.** Why: libraries loaded
  with `dlopen` that keep per-thread state should behave as they do on Linux.

## Later

Bigger directions. Each needs design work, and the order is not fixed.

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
  upstream yet. In a desktop sandbox the Go toolchain (`go`, `gofmt`) already
  builds, runs, tests and vets programs. Go programs cannot run in the browser
  sandbox yet: the browser sandbox runs only programs that share the one memory
  it provides, as C, Rust and Python programs already do, while Go's linker
  gives each program a memory of its own, so `go version` in the tab fails with
  "Exec format error". A change to Go's linker is in progress. The toolchain is
  also large (about 41 MB to download and about 150 MB unpacked, all held in the
  tab's memory), so it would be an opt-in download rather than part of the
  default image. On iPad the per-tab process and memory limits are a further
  question, since `go build` starts several compiler and linker processes.
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

- **No network in the browser tab**, by design. `pip install` and downloads work
  only in the desktop app.
- **Files in the browser are kept in memory only.** A page reload starts a fresh
  sandbox and loses everything you wrote, except a sandbox saved by the
  suspend/resume notebook. Use "Download home" to keep your files.
- **On the desktop**, the root filesystem is also held in memory, and changes to
  it are written to disk at sync points (an explicit `sync`, or when the sandbox
  stops). Host folders you mount are on disk directly.
- **Tablets run the shell only**, with no Jupyter or agent pane. Phones are told
  the sandbox needs a desktop-class browser.
- **Go is not in the playground**, and Go programs cannot run in the browser
  sandbox yet. In a desktop sandbox they run on one thread, and signals reach
  them only between system calls.
- **Gemini CLI is slow to start the first time in the browser**; it starts
  faster in the desktop app.
- **The first boot in the browser takes 30 to 60 seconds** while the tab
  compiles the kernel and programs.

## How it ships

The playground ships as **trains**, roughly weekly. A train releases the kernel,
the image, the desktop app and the `yurt` CLI together, and is named
`playground-YYYY.MM.DD-<kernel commit>`. A train goes live on the site when it
is released.

Each train's notes, including what is not in it and its known issues, are at
<https://yurtos.github.io/yurt-playground/>. Bugs and requests are welcome as
[issues](https://github.com/YurtOS/yurt-playground/issues) in this repository.
