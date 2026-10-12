# Agent Instructions — yurt-playground

Canonical instructions for AI coding agents (Claude Code, Codex, etc.) working
in this repo. `CLAUDE.md` points here.

## Project shape

- **Purpose:** the in-browser Yurt playground. A static page boots a real Yurt
  sandbox: first BusyBox/`ash`, then preinstalled CPython, then the existing
  `yurt-jupyter` stack. This repo owns the page, the local COOP/COEP server,
  artifact pins, and Playwright acceptance. It does **not** own the kernel,
  guest toolchain, image recipes, or Jupyter payload.
- **Languages:** TypeScript on Deno (`deno.json`).
- **Plan:**
  [`docs/superpowers/plans/2026-08-17-browser-yurt-playground.md`](./docs/superpowers/plans/2026-08-17-browser-yurt-playground.md).

## Sibling repos (do not reimplement here)

Check these out next to this repo (`../<name>`). Scripts read `YURT_KERNEL_ROOT`
/ `YURT_PORTS_ROOT` with those relative defaults.

| Repo                                                              | What it owns                                                               |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------- |
| [`YurtOS/yurtos-kernel`](https://github.com/YurtOS/yurtos-kernel) | Kernel wasm, JS host (`attachHostPty`, `dialSandboxPort`, `pumpPtyMaster`) |
| [`YurtOS/yurt-ports`](https://github.com/YurtOS/yurt-ports)       | `playground-image` recipe (`playground.yurtimg`)                           |
| [`YurtOS/yurt-packages`](https://github.com/YurtOS/yurt-packages) | Published BusyBox / later CPython packages                                 |
| [`YurtOS/yurt-jupyter`](https://github.com/YurtOS/yurt-jupyter)   | Jupyter ipykernel payload (unchanged by this page)                         |

Kernel primitives stay in `yurtos-kernel`. Image composition stays in
`yurt-ports`. Do not vendor `kernel.wasm` source or port scripts here.

## Locked decisions

- In-browser. Not a websocket to a native `yurt-runtime-wasmtime`.
- One sandbox, one VFS. xterm talks to a host-owned PTY.
- Jupyter JS dials a port the guest is already listening on (`dialSandboxPort`).
  No `Deno.connect`, no host OS TCP, no guest egress.
- The Notebook/Lab interface is JupyterLite's frontend and server shim with one
  kernel, `yurt`, relaying to the guest `ipykernel`. JupyterLite's own kernels
  (Pyodide, xeus) never ship: the kernel is not replaced, only fronted.
- GitHub Pages cannot set COOP/COEP. Local `scripts/serve.ts` and Cloudflare
  Pages (or equivalent) can.
- Pins are git SHA + sha256 in `artifacts/pins.json`. Blobs (`*.wasm`,
  `*.yurtimg`) are gitignored.

## KISS: the simplest thing that works

Prefer the simplest implementation that satisfies the plan and passes the gates.
Complexity has to be earned by a locked decision, a failing test, or a measured
number — never by anticipation.

- **Solve the case in front of you.** No configuration knobs, options bags, or
  abstraction layers added for a caller that doesn't exist yet. This is one page
  booting one sandbox; when a second consumer appears, generalize then.
- **Fewest moving parts.** No framework, bundler, or state-management layer
  where a module and the DOM will do. Prefer a direct call into the kernel's JS
  host over a wrapper of our own, and one more function over one more module —
  unless the larger structure is what makes the code readable.
- **No defensive paths for states that cannot occur.** If an invariant holds,
  throw on its violation instead of inventing a recovery path nothing exercises.
  A silent `catch` that hides a broken boot is worse than a loud failure.
- **Optimize on evidence.** Caching, prefetching, and worker tricks require a
  measurement that demonstrates the win.
- **Simplify before review.** Delete the debug flag, the dead branch, and the
  helper that ended up with one caller. Reviewers read the diff you leave, so a
  smaller one is a faster merge.

Simple is not terse or clever: clear names, obvious control flow, and a comment
that says _why_ beat a compact expression that has to be decoded.

## The bar: CI green = done

`.github/workflows/ci.yml` is the gate: `deno fmt --check`, `deno lint`,
`deno check '**/*.ts'`, `deno test --no-check` (with read/write/env/net/run). CI
checks out `yurtos-kernel` at the pinned rev so `@yurt/*` imports resolve. A
change is not done until that job is green. Do not claim completion from a local
pass alone.

## Development procedure (non-trivial work)

Always work in your own worktree. Follow the superpowers loop:

1. **Brainstorm** — `superpowers:brainstorming`.
2. **Plan** — `superpowers:writing-plans`. Plans live under
   `docs/superpowers/plans/YYYY-MM-DD-<slug>.md`. Specs under
   `docs/superpowers/specs/`.
3. **Implement with TDD** — `superpowers:test-driven-development`. Red test
   first. Playwright specs live under `tests/`.
4. **Verify** — `superpowers:verification-before-completion`.
5. **Request review** — `superpowers:requesting-code-review`.
6. **Receive review** — `superpowers:receiving-code-review`.

Never merge a pull request unless the user has explicitly ordered that merge in
the current task.

## Code standards

- Format with `deno fmt`; lint with `deno lint`. Both are CI gates.
- Type-check with `deno check '**/*.ts'`.
- Imports: prefer JSR / `node:`-prefixed standard modules. Extend the import map
  in `deno.json`.
- Comments are short and explain non-obvious constraints, not the change
  history.

## Keep PRs reviewable

A PR must be reviewable as a single cohesive unit — one idea, one test strategy
— that one reviewer (human or agent) can hold in mind and check in one pass.
Size is a proxy for that, not the goal. Aim for roughly **1000 lines of new or
changed logic**, weighted by review cost: tests count at about half (repetitive
tests are cheap to check), while mechanical moves, renames, formatting-only
changes, `docs/` (specs, plans, ADRs) and other prose-only files, and
regenerated output (ABI codegen, lockfiles, vendored or generated fixtures) are
free. Regenerated output must be isolated in its own commit and named as
generated in the PR description. Huge PRs cannot be reviewed, so they get
rubber-stamped or stall.

This is a soft target, not a hard cap. Going over is fine, up to roughly 2-3k
weighted lines, when the PR is one cohesive change that doesn't split cleanly;
say why in the PR description. Beyond that, ask the user before opening it.

- **Plan the split up front.** During `superpowers:writing-plans`, cut the work
  into slices that each build, pass CI, and make sense alone (e.g. refactor or
  plumbing → behavior → callers/migration → cleanup). Do not write the whole
  change and slice it afterwards.
- **Don't slice just to hit a number.** Splitting a cohesive change into PRs
  that can't be understood alone makes review harder, not easier. Split along
  real seams, not line counts.
- **Stack the PRs.** Each slice is its own PR based on the previous slice's
  branch (the first on `main`); say "Stack: N/M, depends on #X" in each
  description and keep the stack's overall goal in the first PR. Retarget to
  `main` as lower PRs merge. Never merge a PR without an explicit order from the
  user.
- **Mechanical changes ride alone.** Renames, moves, and formatting-only changes
  go in their own PR so reviewers can skim them; don't mix them with logic
  changes.
- Size is never a reason to skip tests or the red-test-first rule; a slice's
  tests ship in that slice.
- If a PR you're working on is already well over the target, say so to the user
  and propose a split rather than adding to it.

## Conventions

- Commits: short imperative subject (`feat:`, `fix:`, `docs:`, `chore:`).
- Do not add files outside the documented layout without a reason. Do not create
  markdown files speculatively.
- Never commit `artifacts/*.wasm` or `artifacts/*.yurtimg`.

## When in doubt

Read the skill before acting. If a skill applies, invoking it is mandatory — see
`superpowers:using-superpowers`.
