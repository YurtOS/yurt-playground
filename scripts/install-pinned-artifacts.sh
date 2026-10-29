#!/usr/bin/env bash
# install-pinned-artifacts.sh — fetch the pinned kernel wasm and playground
# image from their yurt-packages releases into artifacts/, and the notebook
# kernel's sealable CPython from its yurt-playground release into public/demo/,
# and the sealed sandbox snapshot, when pinned, into public/snapshot/.
#
# Neither blob can be rebuilt by a consumer: the kernel wasm is deterministic
# on a host but not across hosts, and the image needs a guest toolchain and
# hours of port builds. So they are published once (see the release notes on
# each tag) and fetched here, like the Jupyter payload. Each download is
# verified against the sha256 recorded in artifacts/pins.json before it is
# moved into place; a mismatch is an error, never a fallback.
#
# Needs `gh` authenticated for YurtOS/yurt-packages (GH_TOKEN in CI) and `jq`.
set -euo pipefail
default_repo=${YURT_PACKAGES_REPO:-YurtOS/yurt-packages}
root=$(cd "$(dirname "$0")/.." && pwd)
pins=$root/artifacts/pins.json
for tool in gh jq shasum; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "install-pinned-artifacts: $tool is required" >&2
    exit 1
  }
done
cache=$(mktemp -d "${TMPDIR:-/tmp}/yurt-pinned-artifacts.XXXXXX")
trap 'rm -rf "$cache"' EXIT HUP INT TERM

# Retried: the API answers a transient 5xx often enough to matter now that
# CI fetches these per job rather than once (yurt-playground#123). The
# checksum the caller checks is what decides the bytes are right, so a
# retry can only cost time. A 404 is not transient -- a wrong pin should
# say so at once.
download() {
  local tag=$1 repo=$2 pattern=$3 dir=$4 attempt=1
  until gh release download "$tag" --repo "$repo" --pattern "$pattern" \
    --dir "$dir" --clobber 2>"$cache/download.err"; do
    cat "$cache/download.err" >&2
    if grep -qiE "HTTP 4[0-9][0-9]|not found|release not found" "$cache/download.err"; then
      exit 1
    fi
    if [[ $attempt -ge 3 ]]; then
      echo "$pattern: giving up after $attempt attempts" >&2
      exit 1
    fi
    echo "$pattern: attempt $attempt failed, retrying in $((attempt * 5))s" >&2
    sleep $((attempt * 5))
    attempt=$((attempt + 1))
  done
}

fetch() {
  local key=$1 asset=$2 dest=$3
  local tag expected actual repo
  # A pin names where its asset is published when that is not yurt-packages
  # (the CPython blob is a yurt-playground release).
  repo=$(jq -r ".$key.releaseRepo // \"$default_repo\"" "$pins")
  tag=$(jq -r ".$key.release" "$pins")
  expected=$(jq -r ".$key.sha256" "$pins")
  [[ -n "$tag" && "$tag" != "null" ]] || {
    echo "artifacts/pins.json has no $key.release tag" >&2
    exit 1
  }
  echo "fetching $asset from $repo $tag" >&2
  download "$tag" "$repo" "$asset" "$cache"
  actual=$(shasum -a 256 "$cache/$asset" | cut -d' ' -f1)
  if [[ "$actual" != "$expected" ]]; then
    echo "$asset sha256 mismatch: got $actual, pin $expected" >&2
    exit 1
  fi
  mv "$cache/$asset" "$root/$dest"
  echo "installed $tag/$asset as $dest" >&2
}

fetch kernelWasm kernel-wasm.wasm artifacts/yurt_kernel.wasm
fetch image playground-image.yurtimg artifacts/playground.yurtimg
# The slim image the browser boots, published next to the full one, when
# the train pins one.
if [[ "$(jq -r '.browserImage.release // empty' "$pins")" != "" ]]; then
  fetch browserImage playground-slim.yurtimg artifacts/playground-slim.yurtimg
else
  # One from earlier pins would be shipped and listed by the static build.
  rm -f "$root/artifacts/playground-slim.yurtimg"
fi
fetch pythonSeal python3-seal.wasm public/demo/python3-seal.wasm
# The sealed sandbox `?snapshot=1` restores (scripts/release-snapshot.ts),
# when the train pins one and the caller asks for it (YURT_INSTALL_SNAPSHOT=1:
# the deploy, which publishes it): 132 MB that no test reads. A yurt-playground
# release of its parts, joined here and checked against the whole file's
# sha256 the pin records. It is optional: any problem with it -- a
# malformed entry, a failed download, a wrong sha256 -- is a warning and no
# snapshot, never a failed install (the default page must still ship).
install_snapshot() (
  repo=$(jq -er '.snapshot.releaseRepo | strings' "$pins") || exit 1
  tag=$(jq -er '.snapshot.release | strings' "$pins") || exit 1
  count=$(jq -er '.snapshot.parts | arrays | length' "$pins") || exit 1
  expected=$(jq -er '.snapshot.sha256 | strings' "$pins") || exit 1
  echo "fetching sandbox.seal.gz ($count parts) from $repo $tag" >&2
  download "$tag" "$repo" 'sandbox.seal.gz.[0-9]*' "$cache/snapshot" || exit 1
  : > "$cache/sandbox.seal.gz" || exit 1
  for ((i = 0; i < count; i++)); do
    cat "$cache/snapshot/sandbox.seal.gz.$i" >> "$cache/sandbox.seal.gz" || exit 1
  done
  actual=$(shasum -a 256 "$cache/sandbox.seal.gz" | cut -d' ' -f1)
  if [[ "$actual" != "$expected" ]]; then
    echo "sandbox.seal.gz sha256 mismatch: got $actual, pin $expected" >&2
    exit 1
  fi
  mkdir -p "$root/public/snapshot" &&
    mv "$cache/sandbox.seal.gz" "$root/public/snapshot/sandbox.seal.gz" || exit 1
  echo "installed $tag/sandbox.seal.gz as public/snapshot/sandbox.seal.gz" >&2
)

if [[ "$(jq -r '.snapshot // empty' "$pins")" == "" ]]; then
  # One from earlier pins would be checked and left out by the static
  # build; it is not this train's.
  rm -f "$root/public/snapshot/sandbox.seal.gz"
elif [[ "${YURT_INSTALL_SNAPSHOT:-}" == 1 ]]; then
  if ! install_snapshot; then
    echo "WARNING: the pinned sandbox snapshot was not installed; the site ships without ?snapshot=1" >&2
    rm -f "$root/public/snapshot/sandbox.seal.gz"
  fi
else
  echo "sandbox.seal.gz not fetched (YURT_INSTALL_SNAPSHOT=1 fetches it)" >&2
fi
