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

## Previewing a branch

A merge to main deploys the site (`.github/workflows/deploy-pages.yml`). To try
a branch on a real device before it merges, publish it as a preview:

```sh
gh workflow run deploy-pages.yml --ref main -f ref=<branch>
```

It builds and verifies that branch exactly as the production deploy does (the
snapshot included) and publishes it at its Cloudflare branch alias,
`https://<alias>.yurt-playground.pages.dev`: the branch name lowercased, every
other character a hyphen, cut to 28 characters, with no leading or trailing
hyphen (`agent/foo_Bar` → `agent-foo-bar`). The run's summary links the exact
URL. Production is never the target: the preview path refuses `main` and the
Pages project's production branch. Run it from main (`--ref main`), not from the
branch: a branch older than this preview mode carries the old workflow, which
deploys to production. Previews carry the production headers (`dist/_headers`:
the CSP and cross-origin isolation).

## Releasing a train

A release of the page, kernel, images, desktop app and CLI together is one
train, `playground-<YYYY.MM.DD>-<kernel rev>`, cut by
`scripts/release-playground.sh`: it dispatches yurt-sandbox's release workflows
from exact commits, generates `artifacts/pins.json` from what they published,
verifies it, and asks before merging the pin PR that deploys the page.
`--validate` builds everything and publishes nothing; `--pins-only` regenerates
the pins from releases cut by hand.

## The suspend/resume kernel

The _Python 3 (Yurt, suspend/resume)_ kernelspec runs a CPython built so the
sandbox can be sealed (`scripts/build-python-seal.sh`);
`src/notebook_kernel_worker.ts` is the whole kernel.

## Snapshots

The page restores a sealed sandbox made for its device by default, instead of
booting the slim image and installing into it: a desktop browser the one with
the Python set and Jupyter (`snapshot` in the pins), a tablet one with python
alone (`tabletSnapshot`), a phone the slim image as it boots, without Python
(`phoneSnapshot`). Whenever its snapshot cannot be had or is refused, the page
boots the image as before, with a console note; `?snapshot=0` always boots the
image. Each snapshot records what is in that Linux, which the page shows above
the terminal and the shell prints when it starts (it is also `/etc/motd`). A
repeat visit takes the checked parts from the browser's cache (Cache API, keyed
by each part's sha256) instead of downloading them again. See
[Downloads, memory and boot times](../README.md#downloads-memory-and-boot-times)
for each one's size and the memory it needs.

A snapshot is the kernel's memory after an install in the browser, so it is
captured locally rather than by the train:
`deno run -A
scripts/release-snapshot.ts --kind desktop|tablet|phone`, from a
clean checkout at its pushed head whose `artifacts/pins.json` names the train
(with the pinned blobs installed, the sibling kernel checkout clean at the
pinned rev, and Playwright's Chromium). It serves the page, runs
`?snapshot=capture` in headless Chromium, checks that the file decodes in full
and was built from the pinned kernel and image and the Python the live index
offers, publishes it as the prerelease `snapshot-<train>`
(`snapshot-tablet-<train>`, `snapshot-phone-<train>`) and writes its pin, with
its kernel memory and what it holds. `--dry-run` stops before the release and
the pin; `--tag` names a second snapshot of one train (a published one is never
replaced). A train keeps the pin only while `release-snapshot.ts --check-pin`
accepts it, and otherwise drops it and says to run the script again; so does a
change to the page's boot setup (`BOOT_SETUP` in `src/sandbox_snapshot.ts`).
Only the deploy fetches the snapshot (`YURT_INSTALL_SNAPSHOT=1`), and a problem
with it never fails the deploy.

To try another snapshot without a pin or a deploy, capture and upload it
locally:

```sh
deno run -A scripts/snapshot-local.ts [--packages pandas,scipy] [--name NAME]
```

It captures the way `release-snapshot.ts` does (same prerequisites, same checks;
the page checkout need not be a pushed head, which it only notes), and
`--packages` installs those packages after the Python set, before the seal. It
then pushes the parts and a `manifest.json` (the pin's fields) as one parentless
commit to `refs/snapshots/<name>` in YurtOS/yurt-playground (not a branch, so a
clone does not fetch it), reads the manifest back from raw.githubusercontent.com
and prints `https://yurt-playground.pages.dev/?snapshot=<commit sha>`. It first
checks that the live site runs this checkout's build (its `/pins.json`), since
the site restores only its own. The page takes only a 40-digit commit sha, and
restores it only when a `refs/snapshots/*` ref of the repository points at it:
raw.githubusercontent.com also serves fork and pull-request commits under the
repository's path, so the page asks the GitHub API's list of those refs first
(60 unauthenticated requests an hour per address; without an answer it boots the
image). The manifest takes every check the pin does, each part is checked
against it, and anything else boots the image as without the flag. `--file PATH`
uploads an existing capture, `--dry-run` stops before the push. `--kind` picks
the snapshot as above (`?snapshot=capture`, `capture-tablet`, `capture-phone`);
each restores only on a page of its kind, since a page refuses a snapshot whose
Python is not the one it asks the live index about (none on a phone, python
alone on a tablet), and the printed URL names its platform. `--before-deploy`
turns the site check into a note, for a snapshot of pins that a pending deploy
brings. List the uploads with `git ls-remote origin 'refs/snapshots/*'`; delete
one with `git push origin :refs/snapshots/<name>`, after which the page refuses
its URL. Two things the script does not check. First, a capture from page code
that changed `SEAL_VERSION`, `BOOT_SETUP` or the header format against the
deployed page: only the pins are compared, and the site then boots the image
(keep the page checkout at the pushed main). Second, `--packages` extras whose
install moves a member of the Python set: the snapshot keeps the set's label,
which no longer describes its memory.
