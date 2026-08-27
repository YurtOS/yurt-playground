#!/usr/bin/env bash
set -euo pipefail
# The page failing to bundle is invisible to fmt, lint, check, and the unit
# tests: it only shows up when the browser entry points are actually built.
# That is how the import-map resolution bug reached CI.
root="${YURT_KERNEL_ROOT:-../yurtos-kernel}"
if [[ ! -f "$root/packages/kernel-host-interface-js/mod.ts" ]]; then
  echo "skipping bundle check: no kernel checkout at $root" >&2
  exit 0
fi
exec deno run --allow-all --config deno.json - <<'TS'
import { ensureBundle } from "./scripts/serve.ts";
await ensureBundle(Deno.env.get("YURT_KERNEL_ROOT") ?? "../yurtos-kernel");
console.log("bundle ok");
TS
