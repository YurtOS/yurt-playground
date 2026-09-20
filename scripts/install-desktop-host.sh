#!/usr/bin/env bash
# install-desktop-host.sh — fetch the desktop app's native sidecar for one
# target into runtime/<target>/: yurt-desktop-host and yurt-runtime-wasmtime
# from the pinned yurt-packages release (verified against the per-target
# sha256 in artifacts/pins.json), plus the pinned kernel wasm and image from
# artifacts/ (scripts/install-pinned-artifacts.sh first). The launcher runs
# from runtime/<this machine's target>/; scripts/build-desktop.sh bundles
# runtime/<target>/.
#
# Usage: scripts/install-desktop-host.sh [--target <target>]
# Needs `gh` authenticated for YurtOS/yurt-packages (GH_TOKEN in CI) and `jq`.
set -euo pipefail
default_repo=${YURT_PACKAGES_REPO:-YurtOS/yurt-packages}
root=$(cd "$(dirname "$0")/.." && pwd)
pins=$root/artifacts/pins.json
target=$(deno eval 'console.log(Deno.build.target)')
while [ $# -gt 0 ]; do
  case $1 in
    --target) target=$2; shift 2 ;;
    *) echo "install-desktop-host: unknown argument $1" >&2; exit 2 ;;
  esac
done
for tool in gh jq shasum; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "install-desktop-host: $tool is required" >&2
    exit 1
  }
done
for blob in yurt_kernel.wasm playground.yurtimg; do
  [[ -f "$root/artifacts/$blob" ]] || {
    echo "install-desktop-host: artifacts/$blob is missing; run scripts/install-pinned-artifacts.sh" >&2
    exit 1
  }
done
tag=$(jq -r .desktopHost.release "$pins")
# The pin names where its release lives (a train's is a yurt-sandbox
# release; the hand-cut ones are in yurt-packages).
repo=$(jq -r ".desktopHost.releaseRepo // \"$default_repo\"" "$pins")
expected=$(jq -r ".desktopHost.sha256[\"$target\"]" "$pins")
[[ -n "$expected" && "$expected" != "null" ]] || {
  echo "artifacts/pins.json has no desktopHost sha256 for $target" >&2
  exit 1
}
asset=yurt-desktop-host-$target.tar.gz
cache=$(mktemp -d "${TMPDIR:-/tmp}/yurt-desktop-host.XXXXXX")
trap 'rm -rf "$cache"' EXIT HUP INT TERM
echo "fetching $asset from $repo $tag" >&2
gh release download "$tag" --repo "$repo" --pattern "$asset" --dir "$cache" --clobber
actual=$(shasum -a 256 "$cache/$asset" | cut -d' ' -f1)
if [[ "$actual" != "$expected" ]]; then
  echo "$asset sha256 mismatch: got $actual, pin $expected" >&2
  exit 1
fi
dest=$root/runtime/$target
rm -rf "$dest"
mkdir -p "$dest"
tar -xzf "$cache/$asset" -C "$cache"
mv "$cache/yurt-desktop-host/yurt-desktop-host" "$cache/yurt-desktop-host/yurt-runtime-wasmtime" "$dest/"
# The glibc the two binaries import, recorded by releases built from
# yurt-sandbox#258 on: the Linux .deb depends on it (scripts/build-desktop.sh).
rm -f "$dest/GLIBC_REQUIRED"
if [ -f "$cache/yurt-desktop-host/GLIBC_REQUIRED" ]; then
  mv "$cache/yurt-desktop-host/GLIBC_REQUIRED" "$dest/"
fi
cp "$root/artifacts/yurt_kernel.wasm" "$root/artifacts/playground.yurtimg" "$dest/"
echo "installed $tag/$asset as runtime/$target/" >&2
ls -l "$dest" >&2
