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
  # Retried: the API answers a transient 5xx often enough to matter now that
  # CI fetches these per job rather than once (yurt-playground#123). The
  # checksum below is what decides the bytes are right, so a retry can only
  # cost time. A 404 is not transient -- a wrong pin should say so at once.
  attempt=1
  until gh release download "$tag" --repo "$repo" --pattern "$asset" \
    --dir "$cache" --clobber 2>"$cache/download.err"; do
    cat "$cache/download.err" >&2
    if grep -qiE "HTTP 4[0-9][0-9]|not found|release not found" "$cache/download.err"; then
      exit 1
    fi
    if [[ $attempt -ge 3 ]]; then
      echo "$asset: giving up after $attempt attempts" >&2
      exit 1
    fi
    echo "$asset: attempt $attempt failed, retrying in $((attempt * 5))s" >&2
    sleep $((attempt * 5))
    attempt=$((attempt + 1))
  done
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
# when the train pins one: a yurt-playground release of its parts, joined
# here and checked against the whole file's sha256 the pin records.
if [[ "$(jq -r '.snapshot.release // empty' "$pins")" != "" ]]; then
  repo=$(jq -r .snapshot.releaseRepo "$pins")
  tag=$(jq -r .snapshot.release "$pins")
  count=$(jq -r '.snapshot.parts | length' "$pins")
  expected=$(jq -r .snapshot.sha256 "$pins")
  echo "fetching sandbox.seal.gz ($count parts) from $repo $tag" >&2
  gh release download "$tag" --repo "$repo" --pattern 'sandbox.seal.gz.[0-9]*' \
    --dir "$cache/snapshot" --clobber
  : > "$cache/sandbox.seal.gz"
  for ((i = 0; i < count; i++)); do
    cat "$cache/snapshot/sandbox.seal.gz.$i" >> "$cache/sandbox.seal.gz"
  done
  actual=$(shasum -a 256 "$cache/sandbox.seal.gz" | cut -d' ' -f1)
  if [[ "$actual" != "$expected" ]]; then
    echo "sandbox.seal.gz sha256 mismatch: got $actual, pin $expected" >&2
    exit 1
  fi
  mkdir -p "$root/public/snapshot"
  mv "$cache/sandbox.seal.gz" "$root/public/snapshot/sandbox.seal.gz"
  echo "installed $tag/sandbox.seal.gz as public/snapshot/sandbox.seal.gz" >&2
else
  # One from earlier pins would be checked and left out by the static
  # build; it is not this train's.
  rm -f "$root/public/snapshot/sandbox.seal.gz"
fi
