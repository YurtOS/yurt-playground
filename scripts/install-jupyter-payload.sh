#!/usr/bin/env bash
set -euo pipefail

# Install the staged yurt-jupyter payload from a yurt-packages release.
#
# pip cannot rebuild that tree byte-for-byte — --no-binary=:all: resolves build
# backends from PyPI at build time — so the lock's payloadTreeSha256 can only
# pin bytes that are handed out, not rebuilt. Two runs with identical pins
# produced 1ccadfb9 and 4cb5cf6f before this existed.
#
# Latest wins, the same rule yurtos-kernel/scripts/install-yurt-sdk-release.sh
# follows — but resolved by tag prefix, not by "the latest release". That repo
# publishes only SDKs; yurt-packages is shared, so the newest release there may
# be some other package entirely. Set YURT_JUPYTER_PAYLOAD_TAG to pin one.

repo=${YURT_JUPYTER_PAYLOAD_REPO:-YurtOS/yurt-packages}
tag=${YURT_JUPYTER_PAYLOAD_TAG:-}
pattern=${YURT_JUPYTER_PAYLOAD_PATTERN:-jupyter-payload}
jupyter_root=${YURT_JUPYTER_ROOT:-../yurt-jupyter}

if ! command -v gh >/dev/null 2>&1; then
  echo "install-jupyter-payload: gh is required to download the release" >&2
  exit 1
fi

cache=$(mktemp -d "${TMPDIR:-/tmp}/yurt-jupyter-payload.XXXXXX")
staged=""
cleanup() {
  rm -rf "$cache"
  [[ -n "$staged" ]] && rm -rf "$staged"
}
trap cleanup EXIT HUP INT TERM

if [[ -z "$tag" ]]; then
  tag=$(gh api "repos/$repo/releases" --paginate \
    --jq "[.[] | select(.draft | not) | select(.tag_name | startswith(\"$pattern\"))] | first | .tag_name")
  [[ -n "$tag" && "$tag" != "null" ]] || {
    echo "no $pattern release in $repo" >&2
    exit 1
  }
fi

echo "fetching $pattern from $repo $tag" >&2
gh release download "$tag" --repo "$repo" --pattern "$pattern*" --dir "$cache" --clobber

archive=$(find "$cache" -maxdepth 1 -name "$pattern*.tar.zst" -print -quit)
[[ -n "$archive" ]] || {
  echo "no $pattern archive in ${tag:-the latest} $repo release" >&2
  exit 1
}

# The published sha256 is the contract: the payload is only useful if these are
# the exact bytes whose tree hash the lock records.
if [[ -f "$archive.sha256" ]]; then
  expected=$(tr -d '[:space:]' < "$archive.sha256")
  actual=$(shasum -a 256 "$archive" | cut -d' ' -f1)
  if [[ "$expected" != "$actual" ]]; then
    echo "payload sha256 mismatch: got $actual, release $expected" >&2
    exit 1
  fi
else
  echo "warning: $archive has no .sha256 beside it; cannot verify" >&2
fi

staged=$(mktemp -d "${TMPDIR:-/tmp}/yurt-jupyter-stage.XXXXXX")
tar --zstd -xf "$archive" -C "$staged"
[[ -d "$staged/stage" ]] || {
  echo "unexpected archive layout: no stage/ under $staged" >&2
  exit 1
}

mkdir -p "$jupyter_root"
# Replace, do not merge: a leftover file from an older payload would change the
# tree hash and be blamed on the download.
rm -rf "${jupyter_root:?}/stage"
mv "$staged/stage" "$jupyter_root/stage"
echo "installed $(basename "$archive") into $jupyter_root/stage" >&2
