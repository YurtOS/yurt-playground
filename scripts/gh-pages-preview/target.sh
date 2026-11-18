#!/usr/bin/env bash
# Where .github/workflows/preview-gh-pages.yml publishes a branch, as
# `key=value` lines on stdout for $GITHUB_OUTPUT:
#
#   branch=<b>  ref=refs/heads/<b>  folder=<f>
#
# <f> is the folder under preview/ on the gh-pages branch: the branch name
# lowercased, each run of other characters than a-z and 0-9 one hyphen, with
# none leading or trailing (`agent/Foo_bar` -> `agent-foo-bar`). A name that
# is not a branch, or is main (production is Cloudflare's, never a preview),
# exits 1 with an ::error:: line and prints nothing on stdout.
#
# Input (environment): INPUT_REF, the dispatch's `ref` input.
set -euo pipefail

die() {
  echo "::error title=No GitHub Pages preview::$*" >&2
  exit 1
}

# The name as given, never `refs/heads/<b>`: the workflow's concurrency
# group is the raw input, so one branch has one spelling.
branch=${INPUT_REF:-}
[[ -n "$branch" ]] || die "pass ref: <branch>"
[[ "$branch" != refs/* ]] || die "pass the branch name, not '$branch'"
# A branch name git accepts, in characters that are safe in an output line,
# a URL and the job summary.
if ! [[ "$branch" =~ ^[A-Za-z0-9._/-]+$ ]] ||
  ! git check-ref-format --branch "$branch" >/dev/null 2>&1; then
  die "'$branch' is not a branch name this workflow previews"
fi
lower=$(printf '%s' "$branch" | tr '[:upper:]' '[:lower:]')
[[ "$lower" != main ]] || die "main is production; it is never a preview"
folder=$(printf '%s' "$lower" | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//')
[[ -n "$folder" ]] || die "'$branch' has no letters or digits for a folder"

printf 'branch=%s\nref=refs/heads/%s\nfolder=%s\n' "$branch" "$branch" "$folder"
