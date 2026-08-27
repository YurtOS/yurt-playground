#!/usr/bin/env bash
set -euo pipefail
# `deno check` resolves @yurt/* into the sibling kernel checkout. Without it
# every import fails, which says nothing about the commit.
root="${YURT_KERNEL_ROOT:-../yurtos-kernel}"
if [[ ! -f "$root/packages/kernel-host-interface-js/mod.ts" ]]; then
  echo "skipping deno check: no kernel checkout at $root" >&2
  echo "  (set YURT_KERNEL_ROOT, or clone YurtOS/yurtos-kernel beside this repo)" >&2
  exit 0
fi
exec deno check "**/*.ts"
