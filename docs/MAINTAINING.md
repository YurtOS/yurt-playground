# Maintaining the playground

Notes for the people who build and release this repository. Building it needs a
checkout of the Yurt kernel, which is not public yet, next to this one
(`../yurtos-kernel`, at the `kernelWasm.rev` that `artifacts/pins.json` names).
Everyone else should use the hosted page or the releases: they are the supported
way to run the playground.

## Local development

`deno task` lists the tasks. `scripts/serve.ts` serves the page with the
cross-origin isolation headers it needs; `scripts/install-pinned-artifacts.sh`
fetches the pinned kernel and images into `artifacts/`. CI
(`.github/workflows/ci.yml`) is the gate: `deno fmt --check`, `deno lint`,
`deno check`, and the tests. The pre-commit hook (`scripts/install-hooks.sh`)
runs the fast tests.

## Previews

A merge to main deploys nothing. The site deploys only when asked: a dispatch of
`.github/workflows/deploy-pages.yml` from main publishes production,

```sh
gh workflow run deploy-pages.yml --ref main
```

and runs queue one at a time, so the newest dispatch lands last. To try a branch
on a real device before it merges, publish it as a preview. There are two kinds.

- **GitHub Pages, for UI changes:** the page, the terminal, layout, text, the
  notebook pages. Use it by default.
- **Cloudflare Pages, for header, security and isolation changes:** anything
  that touches `_headers`, the CSP (`src/csp.ts`), Permissions-Policy,
  COOP/COEP, the service workers or the snapshots. Only Cloudflare serves the
  production headers.

### GitHub Pages

```sh
gh workflow run preview-gh-pages.yml --ref main -f ref=<branch>
gh workflow run preview-gh-pages.yml --ref main -f ref=<branch> -f remove=true
```

The first builds and verifies the branch as the production deploy does (the same
pinned inputs and checks) and publishes it to the `gh-pages` branch under
`preview/<folder>/`, at
`https://yurtos.github.io/yurt-playground/preview/<folder>/`: the branch name
lowercased, each run of other characters than letters and digits one hyphen,
none leading or trailing (`agent/foo_Bar` → `agent-foo-bar`); a folder that
holds another branch's preview is refused. It runs only when dispatched from
main. The run waits until Pages serves the new build and links it in its
summary. The second deletes that folder. Neither touches anything else on
`gh-pages` (the release notes, `ci/`, other previews), and `main` is refused.
The branch must contain the preview build (`--gh-pages-preview`, this section's
change): merge main into an older branch first.

What a GitHub Pages preview is not:

- GitHub Pages sends no headers. Cross-origin isolation comes from a service
  worker (`scripts/gh-pages-preview/`): a page's first visit registers it and
  reloads once. The CSP is a `<meta>` in each page, without `frame-ancestors`
  and with none for the workers, and there is no Permissions-Policy.
  JupyterLite's own service worker is turned off there, so it cannot take
  `jupyter/` from the isolation worker. **Do not use a GitHub Pages preview to
  test security or isolation changes.**
- It has no device snapshots: the 1 GB site limit. Each page boots the image as
  it does when no snapshot is pinned. A preview is about 220 MB (the image
  parts, the kernel, Python, JupyterLite, the agent's runtime); the snapshots
  alone are 500 MB more.
- Every preview shares the origin `https://yurtos.github.io` with the others,
  the release notes and the other YurtOS repositories' Pages sites
  (yurt-packages, yurt-crates). So their storage is shared (the saved sandboxes,
  the agent's downloaded model, and the OpenRouter key the agent keeps in
  `localStorage`: any page there can read it), and the CSP's `'self'` admits
  scripts, workers and requests from all of them. Do not enter a real key on a
  preview.
- Pages' CDN caches each file for 10 minutes: after a republish, reload hard or
  wait.

Clean up. The publish refuses a site over 900 MB, so a fourth preview needs an
old one removed. List them, then remove those whose branch is merged or gone:

```sh
gh api repos/YurtOS/yurt-playground/contents/preview --jq '.[].name'
gh workflow run preview-gh-pages.yml --ref main -f ref=<branch> -f remove=true
```

A removed preview stays in the `gh-pages` history; identical files across
previews (the same pins) are stored once. If that history ever grows too large,
rewriting `gh-pages` is the owner's call: the release notes live there too.

### Cloudflare Pages

```sh
gh workflow run deploy-pages.yml --ref main -f ref=<branch>
```

It builds and verifies that branch exactly as the production deploy does (the
snapshot included) and publishes it on Cloudflare. Open the deployment's own
hash URL (`https://<hash>.yurt-playground.pages.dev`, "This deployment alone" in
the run's summary), not the branch alias: a branch alias was blocked by name by
an ISP's filter, and a phone hung on it. The alias is the branch name
lowercased, every other character a hyphen, cut to 28 characters, with no
leading or trailing hyphen (`agent/foo_Bar` → `agent-foo-bar`). Production is
never the target: the preview path refuses `main` and the Pages project's
production branch. Run it from main (`--ref main`), not from the branch: a
branch older than this preview mode carries the old workflow, which deploys to
production. Cloudflare previews carry the production headers (`dist/_headers`:
the CSP and cross-origin isolation).

## Rolling back production

Production is whatever the last production deploy published. Only a dispatch of
`deploy-pages.yml` from main with no `ref` makes one (`scripts/deploy-target.sh`
decides), and it builds the commit main pointed at when it was dispatched
(`GITHUB_SHA`). The workflow has no input that names a commit: `ref` takes a
branch and publishes it only as a preview, never main, and a dispatch from a tag
or any ref that is not a branch is refused. So the current workflow cannot put
an older commit back into production. Do not try it by dispatching from a branch
at an old commit either: a commit from before the preview mode (#269) runs its
own, older workflow, which is written to publish that branch to production.
There are two ways back.

- **Fast: Cloudflare's rollback.** First cancel every `deploy-pages.yml` run
  that has not completed (`gh run list -w deploy-pages.yml`, any status but
  `completed`, then `gh run cancel <id>`): a production one would publish main's
  head over the rollback, and cancelling a preview does no harm. Then, in the
  Cloudflare dashboard, open the Pages project that serves
  `yurt-playground.pages.dev`, then its deployments list, and choose _Rollback_
  on an earlier production deployment. Cloudflare serves that deployment's files
  again, as they were built; nothing is rebuilt. Who has dashboard access to
  that project: _owner to fill in_. Main still holds the bad change, so the next
  production dispatch publishes it again: follow up with a revert before anyone
  deploys.
- **Through main: a revert.** Open a pull request that reverts the change, let
  its CI pass, merge it, then dispatch production
  (`gh workflow run deploy-pages.yml --ref main`). That takes about 20 minutes:
  PR CI and the deploy take about 10 minutes each.

Then check what production serves. `integrity.json` names the commit the live
site was built from:

```sh
curl -fsS https://yurt-playground.pages.dev/integrity.json | jq -r .commit
```

After a revert and a deploy it is main's head; after a Cloudflare rollback, the
commit of the deployment you rolled back to. Cloudflare switches a few seconds
after the deploy says it is complete, so check again if the first answer is the
old one. The `--check` mode of `scripts/release-playground.sh` compares the same
commit, and the site's `pins.json`, with main. After a Cloudflare rollback its
`deployed commit` row reads stale until the revert is merged and deployed, and
so does `deployed pins` if the change you rolled back moved
`artifacts/pins.json`.

Two inputs change the live page with no deploy, and neither path above rolls
them back:

- `config/agent-models.json` on this repository's main, which the page reads at
  load through raw.githubusercontent.com (`src/agent_models_config.ts`): the
  agent's models and prompts. Merging a change to it is live within about five
  minutes (GitHub's raw cache). Revert it with a pull request; no deploy needed.
- YurtOS/yurt-packages' main, which the page reads live for every install
  (`PACKAGE_REPO_URL` in `src/packages.ts`): `pkg install`, and the Python the
  page asks the index about. A pinned snapshot whose Python set the index no
  longer offers is refused, and the page boots the image and installs instead.
  Undo it in yurt-packages.

A rolled-back page reads both as they are now, not as they were when it was
built. After a rollback, try the agent pane and a `pkg install` on it, and
revert the model list too if it depends on the change you rolled back.

## Releasing a train

A release of the page, kernel, images, desktop app and CLI together is one
train, `playground-<YYYY.MM.DD>-<kernel rev>`, cut by
`scripts/release-playground.sh`: it dispatches yurt-sandbox's release workflows
from exact commits, generates `artifacts/pins.json` from what they published,
verifies it, and asks before merging the pin PR that deploys the page.
`--validate` builds everything and publishes nothing; `--pins-only` regenerates
the pins from releases cut by hand.

`--browser-only` cuts a train for the page alone, in about 30 minutes instead of
one to two hours: the kernel wasm, the image and the Python seal, the pin PR and
the deploy, but not yurt-sandbox's desktop host and CLI or the desktop
installers. The desktop host and CLI pins are carried through unchanged, with
the kernel rev and the train they were built for (`desktopHost.kernelRev`,
`desktopHost.train`). The home page's download links resolve to the newest
`desktop-<train>` release, which bundles its own kernel, image and runtime, so
they keep serving the last full train's app. A desktop host boots only a kernel
wasm of its own kernel rev, so `scripts/install-desktop-host.sh` and
`scripts/build-desktop.sh` refuse to pair the carried host with the new kernel
pin: no desktop app is built from a browser-only train's pins. Nothing tests the
new image on the new kernel natively either (the image's smoke boots it through
the pinned CLI, which carries its own older kernel), so cut a full train before
many browser-only ones pile up. `--check` shows the desktop app as `BEHIND` (not
`STALE`) until the next full train, which pins its own host and CLI and cuts the
installers again. Leave yurt-sandbox's `scripts/desktop-host-pins.env` at the
desktop's train meanwhile: it describes the host, not the page.

## The suspend/resume kernel

The _Python 3 (Yurt, suspend/resume)_ kernelspec runs a CPython built so the
sandbox can be sealed (`scripts/build-python-seal.sh`);
`src/notebook_kernel_worker.ts` is the whole kernel.

## Snapshots

The page restores a sealed sandbox made for its device by default, instead of
booting the slim image and installing into it: a desktop browser the one with
the Python set and Jupyter (`snapshot` in the pins), a tablet or phone the one
with python alone (`tabletSnapshot`; a phone has had no snapshot of its own
since 2026-11-17). A desktop browser that chooses Go on the start screen
(`?env=go`) restores the Go one instead (`goSnapshot`): the slim image with the
`go` package installed and its build cache already holding the standard library
a small program imports (`GO_WARMUP_IMPORTS` in `src/capture_outcome.ts`), and
no Python or Jupyter. Phones and tablets never get it: `?env=go` there runs the
device's own page, with a note, and the choice is shown only once the site pins
a Go snapshot. Whenever its snapshot cannot be had or is refused, the page boots
the image as before, with a console note; `?snapshot=0` always boots the image.
Each snapshot records what is in that Linux, which the page shows above the
terminal and the shell prints when it starts (it is also `/etc/motd`). A repeat
visit takes the checked parts from the browser's cache (Cache API, keyed by each
part's sha256) instead of downloading them again. See
[Downloads, memory and boot times](../README.md#downloads-memory-and-boot-times)
for each one's size and the memory it needs.

A snapshot is the kernel's memory after an install in the browser, so it is
captured locally rather than by the train:
`deno run -A
scripts/release-snapshot.ts --kind desktop|tablet|go|playwright`,
from a clean checkout at its pushed head whose `artifacts/pins.json` names the
train (with the pinned blobs installed, the sibling kernel checkout clean at the
pinned rev, and Playwright's Chromium). It serves the page, runs
`?snapshot=capture` in headless Chromium, checks that the file decodes in full
and was built from the pinned kernel and image and the Python the live index
offers, publishes it as the prerelease `snapshot-<train>`
(`snapshot-tablet-<train>`, `snapshot-go-<train>`,
`snapshot-playwright-<train>`) and writes its pin, with its kernel memory and
what it holds. Go's capture installs `go` with pkg and then builds a warm-up
program as the login user, so `~/.cache/go-build` holds the compiled standard
library when it is sealed: a user's first `go run` then compiles only their own
package. That build is the slow part of the capture (about 10 min in headless
Chromium), so Go's capture waits up to an hour. Run `scripts/measure-boot.ts`
with `--query 'start&platform=desktop&env=go'` for its `restorePeakMiB`, and
`scripts/verify-snapshots.ts --live --kind go` checks that a first build
compiles nothing of the standard library. Playwright's capture installs `node`
with pkg, then stages playwright-core (the site's own `playwright-core.tgz`),
the `yurt-chrome` module and the example in the login home with the same code
the `?env=playwright` page runs (`src/playwright_setup.ts`), so a restored page
only checks them; `verify-snapshots.ts --live --kind playwright` checks node
loads both. Like Go's, it is optional: a train without it is whole, and the page
then installs live. `--dry-run` stops before the release and the pin; `--tag`
names a second snapshot of one train (a published one is never replaced). A
train keeps the pin only while `release-snapshot.ts --check-pin` accepts it, and
otherwise drops it and says to run the script again; so does a change to the
page's boot setup (`BOOT_SETUP` in `src/snapshot_pin.ts`). The deploy fetches
every snapshot (`YURT_INSTALL_SNAPSHOT=1`), and a problem with one never fails
the deploy. CI's jupyterlite scene fetches only the desktop's
(`YURT_INSTALL_SNAPSHOT=snapshot`): the notebook cannot start without it.

Never add `&platform` to a capture URL. The capture kind alone (`capture`,
`capture-tablet`, `capture-go`, `capture-playwright`) picks what is captured,
and every kind is captured on a desktop page, at desktop size, as
`release-snapshot.ts` runs it (`?start&snapshot=capture-tablet`). A phone or
tablet page (`&platform=phone|tablet`, or a real phone or tablet) is shell-only
(`noPython` in `src/page.ts`), so the capture's Python install never starts: the
page refuses such a capture and says why (#356); before that it booted to
"running" and stopped there without a word. Typical times for a by-hand
`?start&snapshot=capture-tablet` in desktop Chrome: about 67 s to a 78 MB zip,
of which about 32 s installing, 9 s precompiling and 4 s sealing; the desktop
`?start&snapshot=capture` took about 110 s for 143 MB.

To try another snapshot without a pin or a deploy, capture and upload it
locally:

```sh
deno run -A scripts/snapshot-local.ts [--packages pandas,scipy] [--name NAME]
```

It captures the way `release-snapshot.ts` does (same prerequisites, same checks;
the page checkout need not be a pushed head, which it only notes), and
`--packages` installs those packages after the Python set (or Go's go), before
the seal. It then pushes the parts and a `manifest.json` (the pin's fields) as
one parentless commit to `refs/snapshots/<name>` in YurtOS/yurt-playground (not
a branch, so a clone does not fetch it), reads the manifest back from
raw.githubusercontent.com and prints
`https://yurt-playground.pages.dev/?snapshot=<commit sha>`. It first checks that
the live site runs this checkout's build (its `/pins.json`), since the site
restores only its own. The page takes only a 40-digit commit sha, and restores
it only when a `refs/snapshots/*` ref of the repository points at it:
raw.githubusercontent.com also serves fork and pull-request commits under the
repository's path, so the page asks the GitHub API's list of those refs first
(60 unauthenticated requests an hour per address; without an answer it boots the
image). The manifest takes every check the pin does, each part is checked
against it, and anything else boots the image as without the flag. `--file PATH`
uploads an existing capture, `--dry-run` stops before the push. `--kind` picks
the snapshot as above (`?snapshot=capture`, `capture-tablet`, `capture-go`,
`capture-playwright`); each restores only on a page of its kind, since a page
refuses a snapshot whose Python is not the one it asks the live index about
(python alone on a tablet or phone, the go package for Go), and the printed URL
names its platform (and Go's `env=go`). `--before-deploy` turns the site check
into a note, for a snapshot of pins that a pending deploy brings. List the
uploads with `git ls-remote origin 'refs/snapshots/*'`; delete one with
`git push origin :refs/snapshots/<name>`, after which the page refuses its URL.
Two things the script does not check. First, a capture from page code that
changed `SEAL_VERSION`, `BOOT_SETUP` or the header format against the deployed
page: only the pins are compared, and the site then boots the image (keep the
page checkout at the pushed main). Second, `--packages` extras whose install
moves a member of the Python set: the snapshot keeps the set's label, which no
longer describes its memory.
