#!/usr/bin/env bash
# Publish one GitHub Pages preview, or remove it: commit the folder
# preview/<FOLDER>/ of the gh-pages branch and nothing else, then push. The
# release notes and every other file there stay as they are.
#
#   publish.sh publish <site dir>   replace the folder with the site
#   publish.sh remove               delete the folder
#
# Environment: GH_TOKEN (contents: write on REPO), REPO (owner/name),
# FOLDER (scripts/gh-pages-preview/target.sh), BRANCH and COMMIT (for the
# commit message); PAGES_REMOTE, the repository's URL, for the tests. Only
# the folder is fetched: the clone is shallow, sparse and without blobs, so
# the other previews' hundreds of MB are not downloaded. A failed clone or
# push (another preview's push got in first) is retried from a fresh clone;
# the two touch different folders. A refusal (die) is not retried.
set -euo pipefail

# GitHub Pages refuses a site over 1 GB; the release notes share this one.
SITE_LIMIT_BYTES=${SITE_LIMIT_BYTES:-900000000}
# Git hosting refuses a file over 100 MB.
FILE_LIMIT_BYTES=100000000

die() {
  echo "::error title=GitHub Pages preview::$*" >&2
  exit 2
}

mode=${1:-}
site=${2:-}
: "${GH_TOKEN:?}" "${REPO:?}" "${FOLDER:?}" "${BRANCH:?}"
[[ "$FOLDER" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?$ ]] || die "bad folder '$FOLDER'"
case "$mode" in
  publish)
    [[ -n "$site" && -f "$site/index.html" ]] || die "no site at '$site'"
    : "${COMMIT:?}"
    site=$(cd "$site" && pwd)
    ;;
  remove) ;;
  *) die "usage: publish.sh publish <site dir> | remove" ;;
esac
dir=preview/$FOLDER

if [[ "$mode" == publish ]]; then
  big=$(find "$site" -type f -size +"$((FILE_LIMIT_BYTES / 1024))"k)
  [[ -z "$big" ]] || die "files over the 100 MB limit: $big"
  ! find "$site" -type l | grep -q . || die "the site has symbolic links"
  # The site as it would be: every file outside this folder, plus this one.
  others=$(gh api "repos/$REPO/git/trees/gh-pages?recursive=1" --jq \
    "if .truncated then error(\"truncated\") else
       [.tree[] | select(.type == \"blob\" and (.path | startswith(\"$dir/\") | not)) | .size] | add // 0
     end")
  mine=$(find "$site" -type f -exec cat {} + | wc -c | tr -d ' ')
  total=$((others + mine))
  echo "site after publishing: $total bytes ($mine in this preview, $others elsewhere)"
  if ((total > SITE_LIMIT_BYTES)); then
    die "the site would be $total bytes, over $SITE_LIMIT_BYTES: remove an old preview first (docs/MAINTAINING.md \"Previews\")"
  fi
fi

auth=(-c "http.https://github.com/.extraheader=AUTHORIZATION: basic $(printf 'x-access-token:%s' "$GH_TOKEN" | base64 | tr -d '\n')")
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

attempt() {
  rm -rf "$work/pages"
  git "${auth[@]}" clone --quiet --depth 1 --filter=blob:none --sparse \
    --branch gh-pages "${PAGES_REMOTE:-https://github.com/$REPO.git}" "$work/pages"
  cd "$work/pages"
  git sparse-checkout set "$dir"
  git config user.name "github-actions[bot]"
  git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
  if [[ "$mode" == remove && ! -e "$dir" ]]; then
    echo "::warning::there is no preview at $dir"
    return 0
  fi
  git rm -r -q --ignore-unmatch -- "$dir"
  if [[ "$mode" == publish ]]; then
    mkdir -p "$dir"
    cp -R "$site/." "$dir/"
    git add -- "$dir"
  fi
  if git diff --cached --quiet; then
    echo "nothing changed at $dir"
    return 0
  fi
  outside=$(git diff --cached --name-only | grep -v "^$dir/" || true)
  [[ -z "$outside" ]] || die "the commit would change files outside $dir: $outside"
  if [[ "$mode" == publish ]]; then
    git commit -q -m "preview: $BRANCH at $COMMIT"
  else
    git commit -q -m "preview: remove $BRANCH"
  fi
  git "${auth[@]}" push --quiet origin HEAD:gh-pages
}

# Each attempt in a subshell of its own, as a plain command: inside an `if`
# or `||`, errexit would not stop it at a failed step.
for try in 1 2 3 4 5; do
  set +e
  (
    set -e
    attempt
  )
  rc=$?
  set -e
  [[ $rc -ne 0 ]] || exit 0
  [[ $rc -ne 2 ]] || exit 2
  echo "attempt $try did not land; retrying from the current gh-pages" >&2
  sleep $((try * 5))
done
die "gave up after 5 attempts"
