#!/usr/bin/env bash
# install-pinned-artifacts.sh — fetch the pinned kernel wasm and playground
# image from their yurt-packages releases into artifacts/, and the notebook
# kernel's sealable CPython from its yurt-playground release into public/demo/.
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
fetch pythonSeal python3-seal.wasm public/demo/python3-seal.wasm
