#!/usr/bin/env bash
# install-kernel-release.sh — fetch a pre-built kernel.wasm from a
# yurtos-kernel GitHub Release instead of building it from a sibling
# checkout.
#
# yurtos-kernel publishes kernel-v* releases (.github/workflows/
# release-kernel.yml there) containing a single asset, yurt_kernel.wasm.
# This is deliberately informal for now: no version pins, no checksums,
# no ABI-compat manifest -- just fetch a tag (or the latest kernel-v*
# release) and place it where kernelRoot() in scripts/build-static.ts and
# scripts/serve.ts expects a source build to have left it, so nothing
# downstream has to know the difference.
#
# Env vars:
#   YURT_KERNEL_ROOT    default: ../yurtos-kernel sibling
#   KERNEL_WASM_RELEASE tag to install, e.g. kernel-v0.0.3 (default: latest
#                       kernel-v* release)
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
repo="YurtOS/yurtos-kernel"
kernel_root=${YURT_KERNEL_ROOT:-"$root/../yurtos-kernel"}
tag=${KERNEL_WASM_RELEASE:-}
dest_dir="$kernel_root/target/kernel-wasm/release"
dest="$dest_dir/yurt_kernel.wasm"

command -v gh >/dev/null 2>&1 ||
  { echo "gh CLI is required to install a kernel.wasm release" >&2; exit 1; }

[[ -d "$kernel_root" ]] || {
  echo "error: yurtos-kernel checkout not found at $kernel_root" >&2
  echo "set YURT_KERNEL_ROOT=/path/to/yurtos-kernel" >&2
  exit 1
}

if [[ -z "$tag" ]]; then
  # yurtos-kernel's release workflow publishes kernel-v* tags with
  # --latest=false (other release trains, e.g. cpython-wasm-v*, also live in
  # this repo), so GitHub's "latest release" is not necessarily a kernel
  # release. Find the most recent kernel-v* tag instead.
  tag=$(gh api "repos/$repo/releases" --paginate --jq \
    '.[] | select(.draft | not) | select(.prerelease | not) |
      select(.tag_name | startswith("kernel-v")) | .tag_name')
  tag=${tag%%$'\n'*}
  [[ -n "$tag" ]] ||
    { echo "no kernel-v* release found in $repo" >&2; exit 1; }
fi

echo "installing kernel.wasm from $repo release $tag" >&2
mkdir -p "$dest_dir"
work=$(mktemp -d "$dest_dir/kernel-wasm-release.XXXXXX")
trap 'rm -rf "$work"' EXIT
gh release download "$tag" --repo "$repo" \
  --pattern yurt_kernel.wasm --dir "$work" --clobber

mv "$work/yurt_kernel.wasm" "$dest"
printf '%s\n' "$dest"
