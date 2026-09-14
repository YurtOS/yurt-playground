# Browser Yurt Playground Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** A static page that boots a real Yurt sandbox in the browser: first a
BusyBox terminal, then preinstalled CPython, then the existing `yurt-jupyter`
stack with `!` as ordinary guest `/bin/sh`.

**Architecture:** The page loads `kernel.wasm` through
`kernel-host-interface-js`. One sandbox, one VFS. xterm talks to a host-owned
PTY. Jupyter JS dials a port the guest is already listening on
(`dialSandboxPort`). No hosted `yurt-runtime-wasmtime`, no JupyterLite/Pyodide,
no guest egress.

**Tech Stack:** Rust kernel wasm, TypeScript/Deno JS host, BusyBox + CPython +
yurt-jupyter guests, xterm.js, Cloudflare Pages (COOP/COEP).

---

## Locked decisions

- In-browser. Not a websocket to a native runtime.
- New repo `yurt-playground` owns the page. Kernel, ports, packages, and
  `yurt-jupyter` stay in their repos.
- BusyBox first, Python second, Jupyter third. Same page, larger image.
- `yurt-jupyter` already is Jupyter on Wasmtime. Slice 3 only makes the JS host
  run that guest.
- `!` is IPython's subprocess to guest `/bin/sh`. The page does not implement
  `!`.
- The xterm stays after Jupyter lands.
- Network for Jupyter is host-JS → guest listen only. Browser `fetch` to the
  internet stays fail-closed.
- GitHub Pages cannot set COOP/COEP. Local `serve.ts` and Cloudflare Pages (or
  equivalent) can.

## What is already landed (do not redo)

| Building block                                                     | Where                                         | Status                                |
| ------------------------------------------------------------------ | --------------------------------------------- | ------------------------------------- |
| Kernel PTY + `tty.attach` (native)                                 | `packages/kernel`, `runtime-wasmtime`         | Done                                  |
| JS `attachHostPty` / `ptyMasterRead/Write/Close` / `ptySetWinsize` | `feat/js-host-pty-attach` (`9bc2af44b`)       | Unpushed                              |
| JS `dialSandboxPort` ping→pong                                     | `feat/js-host-port-pingpong` (`c02f1da43`)    | Unpushed                              |
| Guest canary source `hostconn-pingpong-canary.c`                   | same branch                                   | Unpushed                              |
| BusyBox `.yurtpkg`                                                 | `yurt-packages`                               | Published                             |
| CPython port                                                       | `yurt-ports/ports/cpython`                    | Built locally; not in `yurt-packages` |
| Jupyter guest tree                                                 | `yurt-jupyter`                                | Exists; Wasmtime smoke                |
| JS host boot + `Runner` (one-shot)                                 | `kernel-host-interface-js`, `packages/runner` | Done                                  |

First kernel work: rebase both feature branches onto current `main`, open PRs,
merge. Do not rewrite the APIs.

### Method IDs

These numbers already exist on the Wasmtime host
(`packages/runtime-wasmtime/src/kernel_host_interface/memory.rs`). The JS
`METHOD` table on `main` only lists **41**. The PTY branch does not allocate new
IDs.

| ID | Symbol                      | On `main` JS `METHOD` | PTY branch                                                                                                                |
| -- | --------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 41 | `KERNEL_TTY_RUNTIME_ACTION` | Already present       | **Reused.** `attachHostPty` sends operation `TTY_RUNTIME_ATTACH_PTY = 3` on this existing method. Do not add a second 41. |
| 47 | `KERNEL_PTY_MASTER_READ`    | Missing               | Added to JS `constants.ts` to match Wasmtime                                                                              |
| 48 | `KERNEL_PTY_MASTER_WRITE`   | Missing               | Added                                                                                                                     |
| 49 | `KERNEL_PTY_MASTER_CLOSE`   | Missing               | Added                                                                                                                     |
| 50 | `KERNEL_PTY_SET_WINSIZE`    | Missing               | Added                                                                                                                     |

`dialSandboxPort` uses existing `SYS_SOCKET_*` IDs (`0x1_0031` and friends). It
does not claim 41 or 47–50.

## Repos and files

```text
yurtos-kernel/                          # OS + JS host
  packages/kernel-host-interface-js/
    mod.ts                              # attachHostPty, dialSandboxPort, pumpPtyMaster
    kernel-host-interface/constants.ts  # see Method IDs below
    __tests__/.../pty_attach.ts
    __tests__/.../port_pingpong.ts
    __tests__/.../pty_pump.ts           # new
    __tests__/browser/                  # new boot canary
  packages/runner/src/                  # optional openSession later

yurt-ports/
  ports/playground-image/               # new compose recipe
    port.toml
    scripts/build.sh                    # stage busybox + init + rootfs
    scripts/package.sh                  # playground.yurtimg or .yurtpkg

yurt-packages/                          # later: publish cpython + image

yurt-jupyter/                           # unchanged payload

yurt-playground/                        # NEW repo
  README.md
  deno.json
  public/index.html
  src/boot.ts
  src/terminal.ts
  src/network.ts                        # dialSandboxPort wrapper for fetch/WS
  scripts/serve.ts
  scripts/pin-artifacts.ts
  artifacts/pins.json                   # sha256 + source rev; blobs gitignored
  tests/playground.spec.ts
```

## Phase map

Each phase is independently demoable. Do not start N+1 until N's exit test is
green.

| Phase | Demo                                          | Repos                         |
| ----- | --------------------------------------------- | ----------------------------- |
| 0     | Land PTY + dial PRs                           | kernel                        |
| 1     | Cooperative PTY pump (Deno)                   | kernel                        |
| 2     | Browser boot canary (echo)                    | kernel                        |
| 3     | BusyBox image                                 | ports                         |
| 4     | Page + xterm + ash                            | playground + kernel           |
| 5     | Python in the same tab                        | ports + packages + playground |
| 6     | `dialSandboxPort` against a real guest canary | kernel                        |
| 7     | Jupyter in the tab                            | playground + kernel threads   |

---

### Task 0: Land the two kernel primitives

**Files:** no new code. Branches `feat/js-host-pty-attach` and
`feat/js-host-port-pingpong`.

- [ ] **Step 1: Rebase both onto `origin/main`**

```bash
git fetch origin main
git checkout feat/js-host-pty-attach && git rebase origin/main
git checkout feat/js-host-port-pingpong && git rebase origin/main
```

- [ ] **Step 2: Re-run the two test files**

```bash
CARGO_TARGET_DIR=~/work/yurtos/yurtos-kernel/target \
  deno test --no-check --allow-read --allow-write --allow-env --allow-net --allow-run \
  packages/kernel-host-interface-js/__tests__/kernel-host-interface/pty_attach.ts \
  packages/kernel-host-interface-js/__tests__/kernel-host-interface/port_pingpong.ts
```

Expected: all tests `ok`.

- [ ] **Step 3: Open two PRs, do not merge without an explicit order**

Subjects: `feat: expose host PTY attach on the JS kernel host` and
`feat: dial a waiting sandbox port from JS`.

---

### Task 1: Cooperative PTY pump

Native `tty.attach` pumps on a background thread. The JS host must yield or the
tab freezes.

**Files:**

- Create:
  `packages/kernel-host-interface-js/__tests__/kernel-host-interface/pty_pump.ts`
- Modify: `packages/kernel-host-interface-js/mod.ts` (add `pumpPtyMaster`)
- Modify:
  `packages/kernel-host-interface-js/__tests__/kernel-host-interface_test.ts`
  (import the new file)

- [ ] **Step 1: Write the failing tests**

```typescript
import {
  freshKernelHostInterface,
  optionalGeneratedFixtureWasm,
  s,
} from "./support.ts";

Deno.test("pumpPtyMaster yields before a second read", async () => {
  const mk = await freshKernelHostInterface();
  const wasm = await optionalGeneratedFixtureWasm("cat-stdin.wasm");
  if (!wasm) throw new Error("missing cat-stdin.wasm");
  const user = mk.spawnUserProcessWithArgs(wasm, [s("cat-stdin")]);
  const pty = mk.attachHostPty(user.pid);
  let turns = 0;
  const stop = mk.pumpPtyMaster(pty, {
    onData: () => {},
    yieldEvery: 1,
    onYield: () => {
      turns += 1;
    },
  });
  await new Promise((r) => setTimeout(r, 20));
  stop();
  if (turns < 1) throw new Error(`pump did not yield, turns=${turns}`);
});

Deno.test("pumpPtyMaster delivers guest output without a busy loop", async () => {
  const mk = await freshKernelHostInterface();
  const wasm = await optionalGeneratedFixtureWasm("cat-stdin.wasm");
  if (!wasm) throw new Error("missing cat-stdin.wasm");
  const user = mk.spawnUserProcessWithArgs(wasm, [s("cat-stdin")]);
  const pty = mk.attachHostPty(user.pid);
  const chunks: Uint8Array[] = [];
  const stop = mk.pumpPtyMaster(pty, { onData: (b) => chunks.push(b) });
  mk.ptyMasterWrite(pty, s("hi\n"));
  mk.ptyMasterWrite(pty, new Uint8Array([0x04]));
  await new Promise((r) => setTimeout(r, 50));
  stop();
  const out = new TextDecoder().decode(
    chunks.reduce((a, b) => {
      const n = new Uint8Array(a.length + b.length);
      n.set(a);
      n.set(b, a.length);
      return n;
    }, new Uint8Array()),
  );
  if (!out.includes("hi")) {
    throw new Error(`missing payload: ${JSON.stringify(out)}`);
  }
});
```

- [ ] **Step 2: Run and confirm red**

```bash
deno test --no-check --allow-all \
  packages/kernel-host-interface-js/__tests__/kernel-host-interface/pty_pump.ts
```

Expected: `mk.pumpPtyMaster is not a function`.

- [ ] **Step 3: Implement `pumpPtyMaster` on `KernelHostInterface`**

```typescript
pumpPtyMaster(
  ptyNum: number,
  opts: {
    onData: (bytes: Uint8Array) => void;
    yieldEvery?: number;
    onYield?: () => void;
  },
): () => void {
  let stopped = false;
  const tick = () => {
    if (stopped) return;
    const chunk = this.ptyMasterRead(ptyNum);
    if (chunk.byteLength > 0) opts.onData(chunk);
    opts.onYield?.();
    setTimeout(tick, opts.yieldEvery ?? 16);
  };
  tick();
  return () => {
    stopped = true;
  };
}
```

Do not `while (true)` read. One read per turn.

- [ ] **Step 4: Re-run tests, expect pass**
- [ ] **Step 5: Commit** `feat: cooperative JS PTY pump`

---

### Task 2: Browser boot canary

Prove Chrome can instantiate `kernel.wasm` under COOP/COEP and run `/bin/echo`.
No xterm.

**Files:**

- Create: `packages/kernel-host-interface-js/__tests__/browser/index.html`
- Create: `packages/kernel-host-interface-js/__tests__/browser/boot.ts`
- Create: `packages/kernel-host-interface-js/__tests__/browser/serve.ts`
- Create: `packages/kernel-host-interface-js/__tests__/browser/boot_test.ts`
  (Playwright or Deno browser)

- [ ] **Step 1: Static server that sets the two headers**

```typescript
// serve.ts
Deno.serve({ port: 4173 }, async (req) => {
  const url = new URL(req.url);
  const path = url.pathname === "/" ? "/index.html" : url.pathname;
  const file = await Deno.readFile(new URL(`.${path}`, import.meta.url));
  return new Response(file, {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
      "content-type": path.endsWith(".html")
        ? "text/html"
        : "application/octet-stream",
    },
  });
});
```

- [ ] **Step 2: Page fails closed without isolation, then boots echo**

`index.html` loads `boot.ts`. `boot.ts`:

```typescript
if (globalThis.crossOriginIsolated !== true) {
  document.body.textContent = "need COOP/COEP";
  throw new Error("not crossOriginIsolated");
}
const kernel = await fetch("./yurt_kernel.wasm").then((r) => r.arrayBuffer());
const echo = await fetch("./echo-args.wasm").then((r) => r.arrayBuffer());
const { KernelHostInterface, defaultHostState, s } = await import(
  "../../mod.ts"
);
const mk = await KernelHostInterface.load(
  new Uint8Array(kernel),
  defaultHostState(),
);
const user = mk.spawnUserProcessWithArgs(new Uint8Array(echo), [
  s("echo"),
  s("hi"),
]);
user.runStart();
document.body.textContent = new TextDecoder().decode(user.capturedStdout());
```

- [ ] **Step 3: Automated check**

Playwright or a Deno test that starts `serve.ts`, opens the page, asserts
`document.body.textContent` contains `hi` (or the echo fixture's actual argv
formatting).

- [ ] **Step 4: Commit** `test: browser COOP/COEP kernel boot canary`

Do **not** put xterm in the kernel repo.

---

### Task 3: Playground BusyBox image (`yurt-ports`)

**Files:**

- Create: `yurt-ports/ports/playground-image/port.toml`
- Create: `yurt-ports/ports/playground-image/scripts/build.sh`
- Create: `yurt-ports/ports/playground-image/scripts/package.sh`

- [ ] **Step 1: `build.sh` stages a rootfs**

```bash
# stage from the already-built BusyBox port + yurt-init
STAGE=build/stage
mkdir -p "$STAGE"/{bin,sbin,etc,tmp,dev,proc,usr/bin}
cp -a ../busybox/build/stage/bin/. "$STAGE/bin/"
# /sbin/init from kernel test-fixtures/wasm/yurt-init (rebuilt via cargo-yurt)
# /etc/passwd, /etc/group from packages/standard-vfs
# /bin/sh already a busybox applet link
```

- [ ] **Step 2: `package.sh` writes `build/dist/playground.yurtimg`**

From the staged root, invoke the kernel CLI image builder. Do not commit the
`.yurtimg`.

```bash
YURT_KERNEL_ROOT="${YURT_KERNEL_ROOT:-../../../yurtos-kernel}"
deno run -A "$YURT_KERNEL_ROOT/packages/cli/src/cli.ts" image build --empty \
  -o build/dist/playground.yurtimg \
  --copy "host:$(pwd)/build/stage:/"
```

- [ ] **Step 3: Smoke the image through the same CLI**

```bash
YURT_KERNEL_ROOT="${YURT_KERNEL_ROOT:-../../../yurtos-kernel}"
deno run -A "$YURT_KERNEL_ROOT/packages/cli/src/cli.ts" \
  build/dist/playground.yurtimg /bin/sh -c 'echo hi'
```

Expected: stdout contains `hi`, exit 0. The CLI loads `yurt_kernel.wasm` via
`readKernelWasm()` and runs `/bin/sh -c` inside the image. This is not
`yurt-sandbox --shell-wasm`.

- [ ] **Step 4: Commit in yurt-ports** `feat: playground BusyBox image recipe`

---

### Task 4: Create `yurt-playground`

New repo. Consumes pinned `kernel.wasm` + `playground.yurtimg`.

**Files (all new):**

- `README.md`
- `deno.json`
- `public/index.html`
- `src/boot.ts`
- `src/terminal.ts`
- `scripts/serve.ts` (same COOP/COEP headers as Task 2)
- `scripts/pin-artifacts.ts`
- `artifacts/pins.json` (checked in; hashes only)
- `tests/playground.spec.ts`
- `.gitignore` (`artifacts/*.wasm`, `artifacts/*.yurtimg`)

- [ ] **Step 1: `serve.ts` + empty page that checks `crossOriginIsolated`**
- [ ] **Step 2: `boot.ts` loads kernel + image, stages ramfs, spawns `/bin/sh`
      on `attachHostPty`**

```typescript
const pty = mk.attachHostPty(shell.pid);
const stop = mk.pumpPtyMaster(pty, {
  onData: (b) => term.write(b),
});
term.onData((data) => mk.ptyMasterWrite(pty, new TextEncoder().encode(data)));
term.onResize(({ rows, cols }) => mk.ptySetWinsize(pty, rows, cols));
```

Use one path only: spawn `/bin/sh` on a host PTY for slice 1. Session-broker
cutover is a later commit in this repo, not a parallel path.

- [ ] **Step 3: Playwright**

```typescript
test("ash echoes", async ({ page }) => {
  await page.goto("http://127.0.0.1:4173/");
  await page.keyboard.type("echo hi");
  await page.keyboard.press("Enter");
  await expect(page.locator(".xterm")).toContainText("hi");
});
```

- [ ] **Step 4: Pin `kernel.wasm` + `playground.yurtimg`**

There is no published kernel-wasm CDN today. CI builds `yurt_kernel.wasm` with
`scripts/build-kernel-wasm.sh` (output
`target/kernel-wasm/release/yurt_kernel.wasm`) and never uploads it as a
playground release. Pins are therefore **git SHA + sha256**, resolved locally or
in CI from sibling checkouts.

Checked-in `artifacts/pins.json`:

```json
{
  "kernelWasm": {
    "repo": "YurtOS/yurtos-kernel",
    "rev": "<full git sha of the kernel commit that built the wasm>",
    "build": "scripts/build-kernel-wasm.sh",
    "path": "target/kernel-wasm/release/yurt_kernel.wasm",
    "sha256": "<hex>"
  },
  "image": {
    "repo": "YurtOS/yurt-ports",
    "rev": "<full git sha of the ports commit that built the image>",
    "build": "ports/playground-image/scripts/package.sh",
    "path": "ports/playground-image/build/dist/playground.yurtimg",
    "sha256": "<hex>"
  }
}
```

`scripts/pin-artifacts.ts` resolution order (fail if none match the pin):

1. If `artifacts/yurt_kernel.wasm` and `artifacts/playground.yurtimg` exist,
   hash them and compare to `pins.json`. Mismatch is a hard error.
2. Else if `YURT_KERNEL_ROOT` / `YURT_PORTS_ROOT` are set, copy from
   `$YURT_KERNEL_ROOT/target/kernel-wasm/release/yurt_kernel.wasm` and
   `$YURT_PORTS_ROOT/ports/playground-image/build/dist/playground.yurtimg`, then
   verify sha256.
3. Else if `PLAYGROUND_KERNEL_WASM_URL` / `PLAYGROUND_IMAGE_URL` are set
   (optional later: GitHub Release assets on this repo, written by a manual
   `refresh-pins` workflow), fetch, verify sha256, write into `artifacts/`.
4. Else exit 2 and print the three options. Do not silently rebuild.

`serve.ts` and Playwright read only from `artifacts/` after a successful pin.
`.gitignore` the blobs; commit `pins.json`.

Playground CI: run `pin-artifacts.ts` (siblings checked out at the pinned revs,
or URLs provided), then Playwright, then deploy the static tree plus
`artifacts/` to Cloudflare Pages with `Cross-Origin-Opener-Policy: same-origin`
and `Cross-Origin-Embedder-Policy: require-corp`. GitHub Pages is not a host.

A manual `refresh-pins` workflow (playground repo) rebuilds or copies, updates
`pins.json`, and opens a PR. Ordinary playground PRs do not rebuild the kernel.

Exit: local `scripts/serve.ts` in Chromium shows ash; `ls`, `uname`, `echo hi`
work; reload is a fresh sandbox.

---

### Task 5: Python in the same image

**Files:**

- Modify: `yurt-ports/ports/playground-image/scripts/build.sh` (install cpython
  stage)
- `yurt-packages`: publish `cpython` if not already
- Modify: `yurt-playground` progress UI + Cache API for the larger download
- Modify: `tests/playground.spec.ts` add `python3 -c 'print(2**20)'`

- [ ] **Step 1: Image contains `/usr/local/bin/python3` and
      `PYTHONHOME=/usr/local`**
- [ ] **Step 2: Playwright: type `python3 -c 'print(2**20)'`, expect `1048576`**
- [ ] **Step 3: Interactive `python3` REPL in the same xterm**

Do not start this until Task 4 is green.

---

### Task 6: Guest ping-pong canary on `dialSandboxPort`

The current JS ping-pong tester listens via kernel syscalls in the test process.
Jupyter needs a **guest** listening.

**Files:**

- Already created: `abi/conformance/c/hostconn-pingpong-canary.c`
- Build to:
  `packages/runner/src/platform/__tests__/fixtures/hostconn-pingpong-canary.wasm`
- Modify:
  `packages/kernel-host-interface-js/__tests__/kernel-host-interface/port_pingpong.ts`

- [ ] **Step 1: Build the C canary with the Yurt guest lane (`yurt-cc` /
      guest-compat)**
- [ ] **Step 2: Change the Deno test to spawn that wasm, wait for
      `/tmp/hostconn-pingpong-ready`, then `dialSandboxPort(18100)`**
- [ ] **Step 3: Assert guest stdout contains `hostconn-pingpong=ok` and JS read
      is `pong`**

This is the last kernel network gate before Jupyter.

---

### Task 7: Jupyter in the tab

**Depends on:** Task 5 green, Task 6 green, and JS-host threads that can run
libzmq's I/O thread next to the kernel (see
`docs/superpowers/specs/2026-07-23-js-host-real-worker-threads-design.md`).
Browser embed was a non-goal of that spec; this task makes it a live
requirement.

**Files:**

- Modify: playground image to install `yurt-jupyter` site-packages
- Create: `yurt-playground/src/jupyter.ts` — start guest `jupyter` / ipykernel,
  `dialSandboxPort` for HTTP/WS (and ZMQ ports if the UI still speaks them)
- Modify: `public/index.html` — notebook pane + existing xterm
- Create: `tests/jupyter.spec.ts`

- [ ] **Step 1: Guest listens; page JS dials that port. No `Deno.connect`.**
- [ ] **Step 2: Notebook `1+1` works**
- [ ] **Step 3: Cell `!echo hi` prints `hi` from BusyBox**
- [ ] **Step 4: xterm still has an ash prompt on the same VFS**

Do not implement guest egress. Do not replace the kernel with JupyterLite.

If threads are not ready, stop after Task 6 and open a kernel issue for “JS host
runs the Wasmtime jupyter_smoke path.” Do not fake a notebook.

---

## Suggested PR / repo order

1. Kernel PRs: PTY attach, then dial (Task 0)
2. Kernel: PTY pump (Task 1)
3. Kernel: browser boot canary (Task 2)
4. yurt-ports: playground image (Task 3) — parallel with 2
5. New `yurt-playground` (Task 4)
6. Python image + page (Task 5)
7. Guest ping-pong canary (Task 6) — can overlap 5
8. Jupyter (Task 7)

## Out of scope until after Task 7

- Second terminal pane (cheap: another `attachHostPty`)
- OPFS persistence
- Allow-listed guest egress
- `yurt-sandbox` JS bindings
- Putting the website in `yurtos-kernel`

## Risks

- Cooperative PTY pump is the remaining xterm gap.
- CPython download/instantiate time is UX (progress + cache), not a reason to
  host remotely.
- Jupyter is blocked on JS-host threads, not on missing notebook code.
- `dialSandboxPort` today is loopback from the JS host's kernel sockets. A guest
  bind on `0.0.0.0` (Jupyter default) may take the bridged/host-TCP path. Task 6
  must prove the guest-visible bind Jupyter will use, and adjust bind address or
  routing if 0.0.0.0 does not hit `dialSandboxPort`.
