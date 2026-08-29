#!/usr/bin/env bash
# Download the published playground rootfs image instead of building it.
#
# Modelled on install-jupyter-payload.sh, and for the same reason: building this
# image from source drags in the pinned kernel's `make -C abi lib`, which builds
# musl and needs a wasi-sdk. CI never installed one, so the build step failed
# with "no wasi-sdk can compile for wasm32-linux-muslwali; set WASI_SDK_PATH"
# whenever the image cache missed. Fetching a published artifact removes the
# toolchain dependency outright rather than adding another install step to
# every consumer.
#
# Latest wins, resolved by TAG PREFIX rather than "the latest release":
# yurt-packages is shared, so its newest release may be some other package
# entirely. Set YURT_PLAYGROUND_IMAGE_TAG to pin one.
set -euo pipefail

repo=${YURT_PLAYGROUND_IMAGE_REPO:-YurtOS/yurt-packages}
tag=${YURT_PLAYGROUND_IMAGE_TAG:-}
pattern=${YURT_PLAYGROUND_IMAGE_PATTERN:-playground-image}
dest=${1:?usage: install-playground-image.sh <dest-path> [expected-sha256]}
expected=${2:-}

if ! command -v gh >/dev/null 2>&1; then
  echo "install-playground-image: gh is required to download the release" >&2
  exit 1
fi

cache=$(mktemp -d "${TMPDIR:-/tmp}/yurt-playground-image.XXXXXX")
trap 'rm -rf "$cache"' EXIT HUP INT TERM

if [[ -z "$tag" ]]; then
  # A bare "gh: Not Found (HTTP 404)" here reads as a missing release but is
  # almost always a token that cannot see this private repo, so say both.
  if ! releases=$(gh api "repos/$repo/releases" --paginate \
    --jq "[.[] | select(.draft | not) | select(.tag_name | startswith(\"$pattern\"))] | first | .tag_name" 2>&1); then
    echo "install-playground-image: cannot list releases in $repo" >&2
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

image=$(find "$cache" -maxdepth 1 -name "$pattern*.yurtimg" -print -quit)
[[ -n "$image" ]] || {
  echo "no $pattern image in $tag $repo release" >&2
  exit 1
}

# Verified before it is moved into place, so a corrupt download fails here
# rather than later as an unbootable image.
actual=$(shasum -a 256 "$image" | awk '{print $1}')
if [[ -n "$expected" && "$actual" != "$expected" ]]; then
  echo "playground image sha256 mismatch" >&2
  echo "  expected (artifacts/pins.json): $expected" >&2
  echo "  downloaded ($tag):              $actual" >&2
  exit 1
fi

mkdir -p "$(dirname "$dest")"
mv -f "$image" "$dest"
echo "installed $dest ($actual)" >&2
