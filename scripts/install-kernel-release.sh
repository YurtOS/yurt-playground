#!/usr/bin/env bash
# install-kernel-release.sh — fetch a pre-built kernel.wasm from a
# yurtos-kernel GitHub Release instead of building it from a sibling
# checkout.
#
# yurtos-kernel publishes kernel-v* releases (.github/workflows/
# release-kernel.yml there) containing a single asset, yurt_kernel.wasm.
# This is deliberately informal for now: no version pins, no checksums,
# no ABI-compat manifest -- just fetch a tag (or the latest release) and
# place it where kernelRoot() in scripts/build-static.ts and scripts/
# serve.ts expects a source build to have left it, so nothing downstream
# has to know the difference.
#
# Env vars:
#   YURT_KERNEL_ROOT    default: ../yurtos-kernel sibling
#   KERNEL_WASM_RELEASE tag to install, e.g. kernel-v0.0.3 (default: latest)
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
kernel_root=${YURT_KERNEL_ROOT:-"$root/../yurtos-kernel"}
tag=${KERNEL_WASM_RELEASE:-}
dest_dir="$kernel_root/target/kernel-wasm/release"
dest="$dest_dir/yurt_kernel.wasm"

command -v gh >/dev/null 2>&1 ||
  { echo "gh CLI is required to install a kernel.wasm release" >&2; exit 1; }

work=$(mktemp -d "${TMPDIR:-/tmp}/kernel-wasm-release.XXXXXX")
trap 'rm -rf "$work"' EXIT

if [[ -n "$tag" ]]; then
  echo "installing kernel.wasm from yurtos-kernel release $tag" >&2
  gh release download "$tag" --repo YurtOS/yurtos-kernel \
    --pattern yurt_kernel.wasm --dir "$work" --clobber
else
  echo "installing kernel.wasm from yurtos-kernel's latest release" >&2
  gh release download --repo YurtOS/yurtos-kernel \
    --pattern yurt_kernel.wasm --dir "$work" --clobber
fi

mkdir -p "$dest_dir"
mv "$work/yurt_kernel.wasm" "$dest"
printf '%s\n' "$dest"
