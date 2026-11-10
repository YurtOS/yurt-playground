# Browser acceptance in Google Chrome

## Why

Playwright 1.55 runs headless `chromium.launch()` on `chromium_headless_shell`,
a separate binary built from Chromium 140. People run Google Chrome 156–157. On
2026-09-20 the notebook passed `notebook_snapshot_e2e.ts` and failed twice in
Chrome 153 ("No Kernel", then a silent cell). The acceptance scenes should run
the browser people use.

## What changes

1. `tests/browser.ts` is the one place a Chromium-family scene starts its
   browser. It launches Playwright's `chrome` channel (the installed Google
   Chrome) by default, and prints the browser and version.
   `PLAYGROUND_BROWSER=chromium` selects Playwright's pinned build, to compare
   with a run from before the switch. Any other value fails the run.
2. The scenes `playground`, `jupyterlite`, `snapshot`, `notebook_snapshot`,
   `agent`, `slim` and `desktop` call it. `agent_demo` and `agent_webgpu`
   already used the `chrome` channel through persistent contexts.
3. `tests/browser_test.ts` fails if a file under `tests/` calls
   `chromium.launch(` directly, or opens a persistent context without the
   `chrome` channel.
4. CI's acceptance job no longer installs or caches Playwright's Chromium for
   those scenes: the `ubuntu-24.04` image ships Google Chrome. A step prints
   `google-chrome --version`. The `webkit` scene is unchanged.
5. `release-desktop.yml` sets `PLAYGROUND_BROWSER=chromium` for the desktop
   scene until a release run has shown it green in Chrome on both runner images.
6. `scripts/measure-boot.ts` takes `--engine chrome`.

## What stays on Playwright's Chromium

`scripts/release-snapshot.ts` and `scripts/verify-snapshots.ts` capture and
check released snapshot bytes. A browser that changes weekly could change those
bytes between releases, so they keep the pinned build.

## Risks

- The runner image updates Chrome weekly, so a scene can turn red with no change
  in this repository. The version line in the log shows when that happened.
  `PLAYGROUND_BROWSER=chromium` reruns a scene on the old engine locally; in CI
  that also needs the `playwright install chromium` step back.
- Playwright 1.55 predates Chrome 156. If the protocol breaks, bump Playwright
  (which also moves the WebKit image tag).
- Headless Chrome is the real binary but not a desktop session: GPU and display
  differ. UI changes still get one run in a desktop Chrome.

## Verification

- `deno test -A tests/browser_test.ts tests/layout_test.ts`.
- Reverting one scene to `chromium.launch()` fails the guard.
- Locally in Chrome 157.0.8103.40: `slim_e2e.ts` and `playground_e2e.ts` pass.
- CI with `ci:full`: every scene in the runner's Chrome.
