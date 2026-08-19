# Playground Hosting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and publish a self-contained, cross-origin-isolated playground
to Cloudflare Pages from GitHub Actions.

**Architecture:** The existing Deno bundler will remain the source of browser
bundles. A new static-build entry point will materialize pinned artifacts, build
the bundles, copy the required public files and binaries into `dist/`, and emit
a Cloudflare Pages `_headers` file. A deployment workflow will run the
repository gates and publish `dist/` only after the build succeeds.

**Tech Stack:** Deno, TypeScript, GitHub Actions, Cloudflare Pages.

**Spec:** `docs/superpowers/specs/2026-08-19-playground-hosting-design.md`

## Global Constraints

- The deployed page must receive `Cross-Origin-Opener-Policy: same-origin`.
- The deployed page must receive `Cross-Origin-Embedder-Policy: require-corp`.
- The deployed assets must be generated from the revisions and hashes in
  `artifacts/pins.json`.
- Generated bundles and binary artifacts remain ignored and uncommitted.
- CI builds `busybox`, `cpython`, `libcxx`, and `libzmq` before packaging the
  image.
- GitHub Pages is not used for the isolated runtime.

---

### Task 1: Make the static build testable

**Files:**

- Modify: `scripts/serve.ts`
- Create: `scripts/build-static.ts`
- Create: `tests/build_static_test.ts`

**Interfaces:**

- `scripts/serve.ts` produces the existing browser bundles through exported
  `ensureBundle(kernel: string)`.
- `scripts/build-static.ts` provides `buildStaticSite()` and writes `dist/` from
  `public/` plus verified files in `artifacts/`.

- [ ] **Step 1: Write the failing test**

Add a test that asserts the static build contract is represented by the build
script: it must name `dist`, `public`, `artifacts`, `_headers`,
`yurt_kernel.wasm`, and `playground.yurtimg`, and it must contain all three
isolation header names.

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `deno test --no-check --allow-read tests/build_static_test.ts`

Expected: FAIL because `scripts/build-static.ts` does not exist yet.

- [ ] **Step 3: Implement the minimal static build**

Export `ensureBundle` from `scripts/serve.ts`. In `scripts/build-static.ts`,
resolve the kernel checkout from `YURT_KERNEL_ROOT` or `../yurtos-kernel`, call
`ensureBundle`, recreate `dist/`, copy `public/index.html`, generated bundle
files, `public/xterm.css`, and the two pinned artifact files, then write
`_headers` with the three isolation headers for `/*`.

- [ ] **Step 4: Run the focused test to verify it passes**

Run: `deno test --no-check --allow-read tests/build_static_test.ts`

Expected: PASS without requiring materialized artifacts because the test checks
the build contract, not the external sibling repositories.

- [ ] **Step 5: Commit**

```bash
git add scripts/serve.ts scripts/build-static.ts tests/build_static_test.ts
git commit -m "feat: add static playground build"
```

### Task 2: Cover the CI dependency and deployment workflow

**Files:**

- Modify: `.github/workflows/ci.yml`
- Create: `.github/workflows/deploy-pages.yml`
- Modify: `tests/layout_test.ts`

**Interfaces:**

- CI materializes the image with
  `scripts/build-all-ports.sh --only busybox cpython libcxx libzmq --build-only`.
- Deployment invokes `deno run ... scripts/build-static.ts` and uploads `dist/`
  with `cloudflare/pages-action@v1`.

- [ ] **Step 1: Extend the failing workflow-contract test**

Assert that CI’s `--only` command contains `cpython`, `libcxx`, and `libzmq`;
assert that the deployment workflow exists and contains `dist`, `_headers`,
`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, and `CLOUDFLARE_PROJECT_NAME`.

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `deno test --no-check tests/layout_test.ts`

Expected: FAIL because CI currently lists only `busybox` and the deployment
workflow does not exist.

- [ ] **Step 3: Implement the workflows**

Update the existing CI command with all four required ports. Add a
push-to-`main`/manual deployment workflow with read-only contents permission,
pinned checkout/setup actions, the same Rust/Deno setup and artifact
materialization sequence, the repository format/lint/check/test commands,
`scripts/build-static.ts`, and the Cloudflare Pages action configured from
repository secrets.

- [ ] **Step 4: Run the focused test to verify it passes**

Run: `deno test --no-check tests/layout_test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/ci.yml .github/workflows/deploy-pages.yml tests/layout_test.ts
git commit -m "ci: deploy playground to Cloudflare Pages"
```

### Task 3: Document setup and run the complete gates

**Files:**

- Modify: `README.md`
- Modify: `deno.json`

- [ ] **Step 1: Add the build task and deployment instructions**

Add `deno task build-static`, document the three Cloudflare repository secrets,
explain why the runtime is not hosted directly on GitHub Pages, and record the
expected Pages project/output-directory configuration.

- [ ] **Step 2: Run formatting and static checks**

Run:

```bash
deno fmt
deno lint
deno check '**/*.ts'
```

Expected: exit code 0 for every command.

- [ ] **Step 3: Run the complete test suite**

Run:
`deno test --no-check --allow-read --allow-write --allow-env --allow-net --allow-run`

Expected: all tests pass; artifact-dependent tests may report their existing
intentional skips when sibling artifacts are unavailable.

- [ ] **Step 4: Review the final diff and commit documentation**

Run `git diff --check` and `git status --short`, then commit:

```bash
git add README.md deno.json
git commit -m "docs: describe playground deployment"
```
