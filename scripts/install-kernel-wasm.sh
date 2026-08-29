#!/usr/bin/env bash
# Download the published kernel wasm instead of building it.
#
# Modelled on install-playground-image.sh. The reason is different from the
# image's, and worth stating: the kernel wasm build IS deterministic on a given
# host, but it is NOT reproducible ACROSS hosts. artifacts/pins.json recorded
# 99374d14... from a maintainer's machine; ubuntu-latest built the same pinned
# rev twice and produced b0e161a0... both times. Every consumer that rebuilt it
# therefore failed the pin check, and no amount of cache keying fixes a hash
# that only one machine can produce.
#
# So the bytes are built once, published, and fetched — the same move already
# made for the Jupyter payload and the playground image. Regenerate with the
# "Publish kernel wasm" workflow, which builds at the pinned rev.
#
# Latest wins, resolved by TAG PREFIX rather than "the latest release":
# yurt-packages is shared, so its newest release may be some other package
# entirely. Set YURT_KERNEL_WASM_TAG to pin one.
set -euo pipefail

repo=${YURT_KERNEL_WASM_REPO:-YurtOS/yurt-packages}
tag=${YURT_KERNEL_WASM_TAG:-}
pattern=${YURT_KERNEL_WASM_PATTERN:-kernel-wasm}
dest=${1:?usage: install-kernel-wasm.sh <dest-path> [expected-sha256]}
expected=${2:-}

if ! command -v gh >/dev/null 2>&1; then
  echo "install-kernel-wasm: gh is required to download the release" >&2
  exit 1
fi

cache=$(mktemp -d "${TMPDIR:-/tmp}/yurt-kernel-wasm.XXXXXX")
trap 'rm -rf "$cache"' EXIT HUP INT TERM

if [[ -z "$tag" ]]; then
  # A bare "gh: Not Found (HTTP 404)" here reads as a missing release but is
  # almost always a token that cannot see this private repo, so say both.
  if ! releases=$(gh api "repos/$repo/releases" --paginate \
    --jq "[.[] | select(.draft | not) | select(.tag_name | startswith(\"$pattern\"))] | first | .tag_name" 2>&1); then
    echo "install-kernel-wasm: cannot list releases in $repo" >&2
    echo "  $releases" >&2
    echo "  $repo is private; GH_TOKEN must be a token scoped to it" >&2
    exit 1
  fi
  tag=$releases
  [[ -n "$tag" && "$tag" != "null" ]] || {
    echo "no $pattern release in $repo" >&2
    exit 1
  }
fi

echo "fetching $pattern from $repo $tag" >&2
gh release download "$tag" --repo "$repo" --pattern "$pattern*" --dir "$cache" --clobber

wasm=$(find "$cache" -maxdepth 1 -name "$pattern*.wasm" -print -quit)
[[ -n "$wasm" ]] || {
  echo "no $pattern wasm in $tag $repo release" >&2
  exit 1
}

# Verified before it is moved into place, so a corrupt download fails here
# rather than later as a kernel that will not instantiate.
actual=$(shasum -a 256 "$wasm" | awk '{print $1}')
if [[ -n "$expected" && "$actual" != "$expected" ]]; then
  echo "kernel wasm sha256 mismatch" >&2
  echo "  expected (artifacts/pins.json): $expected" >&2
  echo "  downloaded ($tag):              $actual" >&2
  exit 1
fi

mkdir -p "$(dirname "$dest")"
mv -f "$wasm" "$dest"
echo "installed $dest ($actual)" >&2
