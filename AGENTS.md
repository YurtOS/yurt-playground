# Agent Instructions — yurt-playground

Org-wide rules live in the `YurtOS/yurtos-rules` repository, not here. After
this file, read its `AGENTS.md` and `org.md` in full, before changing anything.

- Local: `~/work/yurtos/yurtos-rules` (a sibling checkout; read it, do not edit
  it).
- Claude cloud session: attach it read-only with `add_repo` (`owner: YurtOS`,
  `repo: yurtos-rules`, `access: read`), clone it as the tool instructs into a
  directory named exactly `yurtos-rules`, then `register_repo_root` (it rejects
  any other final path segment).
- If it cannot be obtained, stop. Do not read, edit or run anything else. Tell
  the user the rules are missing and that this is an environment problem for
  them to fix.

Skills load as `yurtos-rules:<skill>` only if the user has installed the Claude
Code plugin on this machine
(`claude plugin marketplace add YurtOS/yurtos-rules`, then
`claude plugin install yurtos-rules@yurtos-rules`). Do not install it yourself.
Without it, and in cloud sessions, read `skills/<name>/SKILL.md` in the
yurtos-rules checkout.

If a rule here and an org rule disagree, stop and tell the user.

`CLAUDE.md` points here. This repository's hosted CI budget is
[Hosted CI budget during draft review](#hosted-ci-budget-during-draft-review).

## Project shape

- **Purpose:** the in-browser Yurt playground. A static page boots a real Yurt
  sandbox in the tab (BusyBox `ash`, CPython and the `yurt-jupyter` stack); by
  default it restores a snapshot made for the device. The same page is the
  desktop app's front end, over a native host. This repo owns the page, the
  local COOP/COEP server, the desktop launcher, artifact pins, and Playwright
  acceptance. It does **not** own the kernel, guest toolchain, image recipes, or
  Jupyter payload.
- **Languages:** TypeScript on Deno (`deno.json`).
- **Docs:** [`README.md`](./README.md) for what the playground is today,
  [`docs/MAINTAINING.md`](./docs/MAINTAINING.md) for releasing and snapshots.
  The original plan,
  [`docs/superpowers/plans/2026-08-17-browser-yurt-playground.md`](./docs/superpowers/plans/2026-08-17-browser-yurt-playground.md),
  is history.

## Sibling repos (do not reimplement here)

Check these out next to this repo (`../<name>`). Scripts read `YURT_KERNEL_ROOT`
/ `YURT_PORTS_ROOT` with those relative defaults.

Only this repository and `YurtOS/yurt-packages` are public; the others are
private, so they are named here without links.

| Repo                                                              | What it owns                                                               |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `YurtOS/yurtos-kernel` (private)                                  | Kernel wasm, JS host (`attachHostPty`, `dialSandboxPort`, `pumpPtyMaster`) |
| `YurtOS/yurt-ports` (private)                                     | `playground-image` recipe (`playground.yurtimg`)                           |
| [`YurtOS/yurt-packages`](https://github.com/YurtOS/yurt-packages) | Published packages (the Python set, Node, ...)                             |
| `YurtOS/yurt-jupyter` (private)                                   | Jupyter ipykernel payload (unchanged by this page)                         |

Kernel primitives stay in `yurtos-kernel`. Image composition stays in
`yurt-ports`. Do not vendor `kernel.wasm` source or port scripts here.

## Locked decisions

- The hosted page runs the sandbox in the tab, not over a websocket to a native
  runtime. Only the desktop app's page reaches a native host, through WebSockets
  on its launcher's origin.
- One sandbox, one VFS. xterm talks to a host-owned PTY.
- Jupyter JS dials a port the guest is already listening on (`dialSandboxPort`).
  No `Deno.connect`, no host OS TCP, no guest egress, with one exception.
- The exception: the page's package relay (`src/pkg_relay.ts`) listens on the
  sandbox's loopback (`127.0.0.1:7417`) so the guest's own `pkg` can reach
  YurtOS/yurt-packages. It answers only `GET`s of files under
  `PACKAGE_REPO_URL`, which the page fetches with the browser's `fetch`, under
  the CSP's `connect-src`, with bounded sizes and timeouts. `pkg` verifies every
  byte as on the desktop. One more route, opt-in: a page set up for Playwright
  (`?env=playwright`) serves the guest a DevTools endpoint at `127.0.0.1:9222`
  (`src/cdp_bridge.ts`) whose messages go to the Yurt browser bridge extension
  (`extension/`), which drives tabs it opens in the user's browser only after a
  person allows it in the extension's own window. Through those tabs a guest can
  load any URL with the browser's sign-ins: that is the feature, and the
  approval is its boundary. Guests get no other route out of the sandbox: no
  other host, no DNS.
- The Notebook/Lab interface is JupyterLite's frontend and server shim with one
  kernel, `yurt`, relaying to the guest `ipykernel`. JupyterLite's own kernels
  (Pyodide, xeus) never ship: the kernel is not replaced, only fronted.
- GitHub Pages cannot set COOP/COEP. Local `scripts/serve.ts` and Cloudflare
  Pages (or equivalent) can.
- Pins are git SHA + sha256 in `artifacts/pins.json`. Blobs (`*.wasm`,
  `*.yurtimg`) are gitignored.

## KISS: additions for this repository

org.md "KISS, except where security says otherwise" applies in full, including
its security carve-out. On top of it, here:

- A locked decision above earns complexity the way the spec does in org.md.
- This is one page booting one sandbox; when a second consumer appears,
  generalize then.
- **Fewest moving parts.** No framework, bundler, or state-management layer
  where a module and the DOM will do. Prefer a direct call into the kernel's JS
  host over a wrapper of our own, and one more function over one more module —
  unless the larger structure is what makes the code readable.
- A silent `catch` that hides a broken boot is worse than a loud failure.
- **Simplify before review.** Delete the debug flag, the dead branch, and the
  helper that ended up with one caller. Reviewers read the diff you leave, so a
  smaller one is a faster merge.

Simple is not terse or clever: clear names, obvious control flow, and a comment
that says _why_ beat a compact expression that has to be decoded.

## Verification

What "done" means is org.md "Done means verified": these local checks pass and
every required hosted check on the PR is green.

- Local, the commands `.github/workflows/ci.yml` runs:

  ```sh
  deno fmt --check
  deno lint
  deno check '**/*.ts'
  PLAYGROUND_REQUIRE_ARTIFACTS=1 YURT_KERNEL_ROOT=../yurtos-kernel \
    deno test --no-check --allow-read --allow-write --allow-env --allow-net --allow-run
  ```

  `deno.json` resolves `@yurt/*` imports into a sibling `../yurtos-kernel`
  checkout; CI checks it out at the pinned rev. The tests need the pinned blobs
  (`scripts/install-pinned-artifacts.sh`; CI prepares the rest in
  `.github/actions/site-inputs`). Without `PLAYGROUND_REQUIRE_ARTIFACTS=1` some
  artifact-backed tests skip instead of failing, and such a run is not a pass.
- Hosted: `.github/workflows/ci.yml`.

A pull request skips the slow acceptance scenes (`MERGE_TIER` in ci.yml:
playground, jupyterlite, slim, browser_bridge); they run on every push to main.
Add the `ci:full` label to a pull request that changes what they cover (the
boot, the terminal, the notebook pages, the slim image, the browser bridge) so
they run before the merge, and check main's run after merging one without it.

### Hosted CI budget during draft review

This is the hosted CI budget that the "Hosted CI cost during PR review" section
of
[yurtos-rules `org.md`](https://github.com/YurtOS/yurtos-rules/blob/main/org.md#hosted-ci-cost-during-pr-review)
defers to for this repository, modeled on
[yurtos-kernel's](https://github.com/YurtOS/yurtos-kernel/blob/main/docs/contributing/gates.md#manual-ci-budget-during-draft-review):
**at most one hand-triggered merge-tier round per draft PR, at its final head.**
A round is one `ci.yml` run of the merge-tier acceptance scenes (`MERGE_TIER`)
at the reviewed head, started by adding `ci:full` or by one `workflow_dispatch`
of `ci.yml` on the PR branch. It is not a separate budget for every review
round.

- Between review rounds, use the pull request tier every push already runs
  (fmt/lint, the test shards, the other acceptance scenes) and local tests
  narrowed to what changed. Do not add `ci:full` or dispatch `ci.yml` after each
  round. While `ci:full` is on, every push reruns the merge tier, so add it only
  for the final round and take it off before any push that is not the fix for a
  failed final round. Adding any other label also starts a run, so leave labels
  alone during review.
- Complete the last fix, its review and the local checks before spending the
  round. Check for existing runs at that exact head rather than duplicating
  in-progress or successful coverage. Marking a PR ready runs nothing extra.
- If that final round fails, fix the failure, review the delta and pass the
  local checks before running once more at the corrected final head. Repeat this
  only for an actual failed final round; a successful run does not authorize
  speculative reruns.
- A preview deploy (`deploy-pages.yml` with `ref`, see `docs/MAINTAINING.md`) is
  not CI: dispatch one only when the user asks or the change needs a real-device
  check, once, at the final head. `regenerate-jupyter-payload.yml` and
  `release-desktop.yml` belong to releases, not draft review.
- This applies to every session and any agents or subagents it starts. Put a
  link to this section and the instruction to follow it in their briefs,
  including reviewer briefs.

## Development procedure: additions for this repository

The procedure is org.md "Workflow" (superpowers loop, red test first, review by
both a Claude and a Codex agent) and "Merge authority". On top of it, here:

- Playwright specs live under `tests/`. They run the installed Google Chrome
  through `scripts/browser.ts`; `PLAYGROUND_BROWSER=chromium` runs Playwright's
  own build instead (after `playwright install chromium`).

## Code standards

- Format with `deno fmt`; lint with `deno lint`. Both are CI gates.
- Type-check with `deno check '**/*.ts'`.
- Imports: prefer JSR / `node:`-prefixed standard modules. Extend the import map
  in `deno.json`.
- Comments are short and explain non-obvious constraints, not the change
  history.

## Keep PRs reviewable: additions for this repository

PR size, how test lines are counted and reported, stacking and retargeting, and
mechanical-only PRs are org.md "Pull requests". On top of it, here:

- `docs/` (specs, plans, ADRs) counts as prose, so it is free. Name regenerated
  output as generated in the PR description, as well as putting it in its own
  commit.
- **Plan the split up front** into slices that each build, pass CI, and make
  sense alone (e.g. refactor or plumbing → behavior → callers/migration →
  cleanup). Keep the stack's overall goal in the first PR's description.
- **Don't slice just to hit a number.** Splitting a cohesive change into PRs
  that can't be understood alone makes review harder, not easier. Split along
  real seams, not line counts.
- Size is never a reason to skip tests or the red-test-first rule; a slice's
  tests ship in that slice.
- If a PR you're working on is already well over the target, say so to the user
  and propose a split rather than adding to it.

## Conventions: additions for this repository

Commit messages, plan and spec paths and markdown files follow org.md
"Conventions". On top of it, here:

- Do not add files outside the documented layout without a reason.
- Never commit `artifacts/*.wasm` or `artifacts/*.yurtimg`.

## When in doubt

Read the skill before acting. If a skill applies, invoking it is mandatory — see
`superpowers:using-superpowers`.

## Worktree hygiene

- Work in your own worktree. When you finish a PR (merged or closed) or a
  review, remove the worktree you created for it (`git worktree remove`).
  Confirm it is clean and the branch is pushed first, and push unpushed work to
  a branch rather than losing it.
- Delete only your own worktrees and build output, never another session's.
  Build directories run to tens of GB per worktree; ask an owner before pruning
  theirs.
