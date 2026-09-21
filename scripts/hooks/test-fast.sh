#!/usr/bin/env bash
set -euo pipefail
# boot_test.ts and python_test.ts boot a real sandbox from pinned blobs that
# are gitignored, and they demand the artifacts rather than skipping, so they
# cannot pass on a clean checkout. CI runs them with PLAYGROUND_REQUIRE_ARTIFACTS=1.
# --ignore replaces deno.json's test.exclude rather than adding to it, so
# the worktree directories must be named again here: a checkout with
# .worktrees/<x>/ otherwise runs every worktree's suite against this
# tree's artifacts (and fails on theirs).
exec deno test --no-check --allow-read --allow-write --allow-env --allow-net --allow-run \
  --ignore=tests/boot_test.ts,tests/python_test.ts,.worktrees,worktrees
