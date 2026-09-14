#!/usr/bin/env bash
# install-pinned-artifacts.sh — fetch the pinned kernel wasm and playground
# image from their yurt-packages releases into artifacts/.
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
repo=${YURT_PACKAGES_REPO:-YurtOS/yurt-packages}
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
  local tag expected actual
  tag=$(jq -r ".$key.release" "$pins")
  expected=$(jq -r ".$key.sha256" "$pins")
  [[ -n "$tag" && "$tag" != "null" ]] || {
    echo "artifacts/pins.json has no $key.release tag" >&2
    exit 1
  }
  echo "fetching $asset from $repo $tag" >&2
  gh release download "$tag" --repo "$repo" --pattern "$asset" --dir "$cache" --clobber
  actual=$(shasum -a 256 "$cache/$asset" | cut -d' ' -f1)
  if [[ "$actual" != "$expected" ]]; then
    echo "$asset sha256 mismatch: got $actual, pin $expected" >&2
    exit 1
  fi
  mv "$cache/$asset" "$root/artifacts/$dest"
  echo "installed $tag/$asset as artifacts/$dest" >&2
}

fetch kernelWasm kernel-wasm.wasm yurt_kernel.wasm
fetch image playground-image.yurtimg playground.yurtimg
