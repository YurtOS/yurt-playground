# Python Playground Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a pinned playground image containing CPython 3 with working
`python` and `python3` commands, verified through the real browser PTY path.

**Architecture:** Extend the existing `yurt-ports` playground-image composition
with the published CPython package and image-local aliases. Keep the browser
boot path single-sandbox/single-PTY, add a cache-aware progress fetch adapter at
the artifact boundary, and make Python acceptance tests fail when configured
artifacts cannot boot.

**Tech Stack:** Bash port recipes, Yurt image builder, Rust/Deno package
repository tooling, TypeScript/Deno, browser Cache API, PTY acceptance tests.

**Spec:** `docs/superpowers/specs/2026-08-18-python-playground-design.md`

## Global Constraints

- The unversioned `python` name is a Python 3 alias; Python 2 is not supported
  or future.
- The image stages CPython under `/usr/local` and creates
  `/usr/local/bin/python` and `/usr/local/bin/python3` symlinks to
  `cpython3.wasm`.
- The initial ash process receives `PYTHONHOME=/usr/local` explicitly.
- Task 5 integration tests use `requireArtifacts: true` and never silently skip.
- Artifact bytes are accepted only after exact SHA-256 verification; stale or
  mismatched cache entries are discarded.
- Never commit `artifacts/*.wasm` or `artifacts/*.yurtimg`.

---

### Task 1: Publish the CPython package

**Files:**

- Create in an isolated yurt-packages worktree: `packages/cpython.json`,
  `artifacts/cpython/3.14.4/cpython-3.14.4-yurt_0.yurtpkg`, its bundle, and
  generated `index.json` updates.
- Test with the `yurt-repo-ci publish-local` contract from `yurt-pkg`.

**Interfaces:**

- Consumes: `yurt-ports/ports/cpython/build/dist/cpython-3.14.4-yurt_0.yurtpkg`
  and `yurt-ports/ports/cpython/yurt-pack.toml`.
- Produces: repository metadata resolving package `cpython` version `3.14.4`,
  build `yurt_0`, and its artifact URL for image composition and CI.

- [ ] **Step 1: Create a clean yurt-packages worktree and verify the package is
      not already indexed.**

```bash
git -C /Users/sunny/work/yurtos/yurt-packages worktree add /Users/sunny/work/yurtos/yurt-packages/.worktrees/feat/cpython-package -b feat/cpython-package origin/main
rg -n 'cpython' /Users/sunny/work/yurtos/yurt-packages/.worktrees/feat/cpython-package/index.json /Users/sunny/work/yurtos/yurt-packages/.worktrees/feat/cpython-package/packages || true
```

Expected: the worktree is clean and no published CPython entry exists.

- [ ] **Step 2: Publish the existing artifact locally and run metadata tests.**

```bash
cargo run --manifest-path /Users/sunny/work/yurtos/yurt-pkg/Cargo.toml -p yurt-repo-ci -- publish-local --repo-root /Users/sunny/work/yurtos/yurt-packages/.worktrees/feat/cpython-package --artifact /Users/sunny/work/yurtos/yurt-ports/ports/cpython/build/dist/cpython-3.14.4-yurt_0.yurtpkg --manifest /Users/sunny/work/yurtos/yurt-ports/ports/cpython/yurt-pack.toml --generated-at 2026-08-18T00:00:00Z --reject-existing
cargo test --manifest-path /Users/sunny/work/yurtos/yurt-pkg/Cargo.toml -p yurt-repo-ci
```

Expected: the cpython package entry, artifact, placeholder bundle, and index are
generated and the package-tool tests pass.

- [ ] **Step 3: Inspect generated metadata and commit the package publication.**

Verify the manifest records the exact artifact filename, SHA-256, size, version,
build, and `cpython3` command, then commit only generated CPython publication
files:

```bash
git add artifacts/cpython packages/cpython.json index.json index.json.bundle
git commit -m "chore: publish cpython package"
```

### Task 2: Compose CPython and aliases into the playground image

**Files:**

- Modify:
  `/Users/sunny/work/yurtos/yurt-ports/.worktrees/playground-image/ports/playground-image/scripts/build.sh`
- Modify: `.../ports/playground-image/scripts/test.sh`
- Modify: `.../ports/playground-image/README.md`

**Interfaces:**

- Consumes: the published CPython `.yurtpkg` selected by an explicit
  package/stage environment variable, plus existing BusyBox/init stages.
- Produces: `/usr/local/bin/cpython3.wasm`, `/usr/local/bin/python`,
  `/usr/local/bin/python3`, and the CPython standard library.

- [ ] **Step 1: Add a failing image smoke assertion for both aliases and Python
      3 semantics.**

Extend the smoke sequence with:

```bash
run_cli /bin/sh -c 'test -L /usr/local/bin/python && test -L /usr/local/bin/python3'
run_cli /bin/sh -c 'python3 -c "print(2**20)"' | grep -qx '1048576'
run_cli /bin/sh -c 'python -c "import sys; print(sys.version_info[0])"' | grep -qx '3'
```

Run `scripts/test.sh` before changing the builder. Expected: failure because the
image has no CPython files.

- [ ] **Step 2: Stage CPython and create image-local symlinks.**

Update `build.sh` to resolve and extract the package into the image stage,
reject missing package/interpreter/stdlib with specific errors, then create:

```bash
ln -s cpython3.wasm "$STAGE/usr/local/bin/python"
ln -s cpython3.wasm "$STAGE/usr/local/bin/python3"
```

Preserve existing ownership/mode policy for system files and user home.

- [ ] **Step 3: Run the image smoke and owner checks against a fresh build.**

Run the package/build/test sequence with sibling kernel, ports, and package
roots configured. Expected: aliases, Python-3 identity, one-shot output
`1048576`, ash smoke, and owner checks pass.

- [ ] **Step 4: Document the CPython input and Python command contract, then
      commit.**

Record the exact environment override and build prerequisite, including that
`python` and `python3` are Python 3 aliases:

```bash
git add ports/playground-image
git commit -m "feat: add cpython to playground image"
```

### Task 3: Make the boot environment and artifact harness Python-ready

**Files:**

- Modify: `src/boot.ts`
- Modify: `tests/ash_harness.ts`
- Test: `tests/boot_test.ts`

**Interfaces:**

- Consumes: the pinned image from `resolveArtifacts` and the existing
  `bootPlayground` PTY.
- Produces: `PYTHONHOME=/usr/local` in `DEFAULT_ENV` and
  `bootAshSession({ requireArtifacts: true })` that throws artifact/boot
  failures instead of returning `undefined`.

- [ ] **Step 1: Add red harness tests for explicit Python environment and
      required artifact errors.**

Add a boot-environment assertion and a resolver test proving
`bootAshSession({ requireArtifacts: true })` rejects a missing/mismatched
configured artifact rather than logging a skip. Run focused tests and expect
failure against the current API.

- [ ] **Step 2: Add `PYTHONHOME` and the required-artifact option.**

Use this API:

```ts
export type AshSessionOptions = { requireArtifacts?: boolean };
export async function bootAshSession(
  options: AshSessionOptions = {},
): Promise<AshSession | undefined>;
```

If resolution fails with `requireArtifacts`, rethrow the original error; retain
optional ash skip behavior otherwise.

- [ ] **Step 3: Run boot/stage tests with and without configured artifacts.**

```bash
deno test --allow-read --allow-write --allow-env --allow-net --allow-run tests/boot_test.ts tests/stage_test.ts
```

Expected: only optional ash tests skip without artifacts; configured sessions
fail on resolution/boot/runtime errors.

### Task 4: Add cache-aware artifact downloads with progress

**Files:**

- Create: `src/artifact_fetch.ts`
- Modify: `src/boot.ts`, `src/coordinator_worker.ts`, and `src/page.ts`
- Test: `tests/artifact_fetch_test.ts`

**Interfaces:**

- Consumes: `ArtifactPin`, same-origin artifact URLs, injected fetch/cache, and
  progress callback.
- Produces: `fetchPinnedArtifact(pin, options): Promise<Uint8Array>` verifying
  cache/network bytes, reporting `{ loaded, total }`, deleting invalid cache
  entries, and failing closed on hash mismatch.

- [ ] **Step 1: Write deterministic red tests for valid cache, stale cache,
      progress, and network mismatch.**
- [ ] **Step 2: Implement exact-hash cache/network fetching; cache only verified
      bytes and discard mismatches.**
- [ ] **Step 3: Wire progress into existing worker status messages while
      preserving injected Deno `fetchBytes`.**
- [ ] **Step 4: Run `deno test tests/artifact_fetch_test.ts`,
      `deno check '**/*.ts'`, and page tests; commit as
      `feat: cache pinned playground artifacts`.**

### Task 5: Add real Python PTY acceptance coverage

**Files:**

- Create: `tests/playground.spec.ts` or the existing Deno acceptance equivalent
- Modify: `tests/ash_harness.ts`

**Interfaces:**

- Consumes: the composed pinned image,
  `bootAshSession({ requireArtifacts: true })`, and `typeCommand`.
- Produces: non-skipping tests for one-shot `python3`, explicit `PYTHONHOME`,
  unversioned `python`, and interactive `python3` REPL.

- [ ] **Step 1: Add real-session assertions for `python3 -c 'print(2**20)'`,
      `PYTHONHOME`, `python -c 'print(2**20)'`, and a `python3` REPL expression
      returning `42`; clean up with `session.stop()` in `finally`. Verify
      missing artifacts produce a failure, not a skip.**
- [ ] **Step 2: Fix only runtime/image issues exposed by the red real-session
      test and rebuild the exact pair.**
- [ ] **Step 3: Run fmt, lint, type-check, and all Deno tests with
      `YURT_KERNEL_ROOT` and `YURT_PORTS_ROOT`; verify Task 5 emits no skip.**
- [ ] **Step 4: Commit as `test: exercise Python through playground PTY`.**

### Task 6: Pin the exercised image and enforce CI

**Files:**

- Modify: `artifacts/pins.json`
- Modify: `.github/workflows/ci.yml`
- Modify: `README.md` only if build prerequisites need documenting

**Interfaces:**

- Consumes: exact tested kernel/image revisions and hashes.
- Produces: CI that checks out/builds the pinned kernel, materializes CPython,
  composes the image, pins artifacts, and runs required Python acceptance tests.

- [ ] **Step 1: Add CI assertions that both sibling artifacts exist before Deno
      tests and that Task 5 is configured required.**
- [ ] **Step 2: Update checkout/build order to make the published CPython
      package available, build the image, and run `scripts/pin-artifacts.ts`
      before Deno gates.**
- [ ] **Step 3: Update image pin only after hashing the exact successful pair;
      never commit generated blobs.**
- [ ] **Step 4: Run the full workflow-equivalent gate, inspect every diff, and
      commit as `feat: pin Python playground image`; request review for all
      affected repository branches.**

## Self-review checklist

- Command names, Python 3-only policy, `PYTHONHOME`, cache/progress,
  required-artifact behavior, and CI non-skipping each have an explicit task.
- Every production change has a preceding red test or smoke assertion.
- Existing image worktree and a separate package worktree preserve unrelated
  dirty state.
- No generated wasm or yurtimg blobs are committed.
