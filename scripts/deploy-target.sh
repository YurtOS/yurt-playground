#!/usr/bin/env bash
# What .github/workflows/deploy-pages.yml publishes, as `key=value` lines on
# stdout for $GITHUB_OUTPUT:
#
#   mode=production  branch=main  ref=<GITHUB_SHA>
#     a push to main, or a dispatch from main with no `ref` input;
#   mode=preview  branch=<b>  ref=refs/heads/<b>  alias=<Cloudflare alias>
#     a dispatch with `ref: <b>`, or a dispatch from branch <b> with none.
#
# Anything else, and a preview of the production branch, exits 1 with an
# ::error:: line and prints nothing on stdout. The preview deploy step also
# asks the Pages project for its production branch and refuses it; this
# script refuses `main` before anything is built.
#
# Inputs (environment): EVENT (github.event_name), GITHUB_REF, GITHUB_SHA,
# INPUT_REF (the dispatch input; empty when absent).
set -euo pipefail

production_branch=main

die() {
  echo "::error title=Playground was not deployed::$*" >&2
  exit 1
}

production() {
  printf 'mode=production\nbranch=%s\nref=%s\n' "$production_branch" \
    "$GITHUB_SHA"
  exit 0
}

case "${EVENT:-}" in
  push)
    [[ "$GITHUB_REF" == "refs/heads/$production_branch" ]] ||
      die "a push to $GITHUB_REF; only $production_branch deploys on push"
    production
    ;;
  workflow_dispatch) ;;
  *) die "event '${EVENT:-}' does not deploy" ;;
esac

if [[ -n "${INPUT_REF:-}" ]]; then
  branch=${INPUT_REF#refs/heads/}
elif [[ "$GITHUB_REF" == "refs/heads/$production_branch" ]]; then
  production
elif [[ "$GITHUB_REF" == refs/heads/* ]]; then
  branch=${GITHUB_REF#refs/heads/}
else
  die "dispatched from $GITHUB_REF, which is not a branch; pass ref: <branch>"
fi

# A branch name git accepts, in characters that are safe in an output line,
# a URL and the job summary.
if ! [[ "$branch" =~ ^[A-Za-z0-9._/-]+$ ]] ||
  ! git check-ref-format --branch "$branch" >/dev/null 2>&1; then
  die "'$branch' is not a branch name this workflow previews"
fi

lower=$(printf '%s' "$branch" | tr '[:upper:]' '[:lower:]')
[[ "$lower" != "$production_branch" ]] ||
  die "'$branch' is the production branch; previews never publish it (push to main deploys production)"

# Cloudflare's branch alias: lowercased, every other character a hyphen, cut
# to 28 characters; a DNS label neither starts nor ends with a hyphen. The
# deploy step reports the alias Cloudflare actually assigned and warns if it
# differs.
alias=$(printf '%s' "$lower" | sed 's/[^a-z0-9]/-/g' | cut -c1-28 |
  sed 's/^-*//; s/-*$//')
[[ -n "$alias" ]] || die "'$branch' has no letters or digits for an alias"

printf 'mode=preview\nbranch=%s\nref=refs/heads/%s\nalias=%s\n' \
  "$branch" "$branch" "$alias"
