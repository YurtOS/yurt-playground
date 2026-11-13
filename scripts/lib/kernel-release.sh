# shellcheck shell=bash
# Resolve the immutable kernel-v* release input for yurt-sandbox's workflow.
resolve_kernel_release() {
  local dir=$1 sha=$2 tag local_sha refs remote_sha
  git -C "$dir" rev-parse --git-dir >/dev/null 2>&1 \
    || die "no checkout at $dir to resolve a kernel-v* tag from; pass --kernel-sha with a checkout present, or set YURT_KERNEL_ROOT"
  git -C "$dir" fetch -q origin --tags \
    || die "could not fetch kernel-v* tags from $dir"

  local matches=()
  local tags
  tags=$(git -C "$dir" for-each-ref --format='%(refname:short)' "refs/tags/kernel-v*") \
    || die "could not list kernel-v* tags in $dir"
  while IFS= read -r tag; do
    [ -n "$tag" ] || continue
    local_sha=$(git -C "$dir" rev-parse "$tag^{commit}") || continue
    [ "$local_sha" = "$sha" ] || continue

    refs=$(git -C "$dir" ls-remote origin "refs/tags/$tag" "refs/tags/$tag^{}") \
      || die "could not verify remote target for $tag"
    remote_sha=$(printf '%s\n' "$refs" | awk '
      $2 ~ /\^\{\}$/ { peeled = $1 }
      $2 !~ /\^\{\}$/ { direct = $1 }
      END { print peeled ? peeled : direct }
    ')
    [ "$remote_sha" = "$sha" ] && matches+=("$tag")
  done <<< "$tags"

  [ "${#matches[@]}" -gt 0 ] \
    || die "no kernel-v* release tag in yurtos-kernel points at $sha; cut one there first"
  printf '%s\n' "${matches[@]}" | sort -V | tail -1
}

# Wait for yurtos-kernel's published (non-draft) release of TAG: pushing a
# kernel-v* tag starts release-kernel.yml, which takes minutes to publish it,
# and yurt-sandbox's release-kernel-wasm.yml fails on a tag with no release
# yet (#326). Stops at once when that run failed, and after
# YURT_KERNEL_RELEASE_TIMEOUT_SECS (30 minutes) otherwise.
wait_for_kernel_release() {
  local tag=$1 draft run
  local deadline=$((SECONDS + ${YURT_KERNEL_RELEASE_TIMEOUT_SECS:-1800}))
  while :; do
    # The check yurt-sandbox's workflow makes. A 404 (no release yet) and
    # a draft both mean wait.
    draft=$(gh api "repos/YurtOS/yurtos-kernel/releases/tags/$tag" --jq .draft 2>/dev/null) || draft=""
    [ "$draft" = false ] && return
    # The tag push's run, not a build-only workflow_dispatch on the tag.
    run=$(gh run list --repo YurtOS/yurtos-kernel --workflow release-kernel.yml --branch "$tag" \
      --event push --limit 1 --json status,conclusion,url \
      --jq '.[0] // empty | "\(.status) \(.conclusion) \(.url)"' 2>/dev/null) || run=""
    case $run in
      "completed success "*) ;;
      completed\ *)
        run=${run#completed }
        die "yurtos-kernel release-kernel.yml for $tag ended ${run%% *} (${run#* }), so it has no release; fix it, then $(resume_command)" ;;
    esac
    [ "$SECONDS" -lt "$deadline" ] \
      || die "yurtos-kernel's release for $tag is not published (${draft:+draft: $draft; }release-kernel.yml: ${run:-no run found}); once it is, $(resume_command)"
    say "waiting for yurtos-kernel's release of $tag (${run:-no release-kernel.yml run yet})"
    sleep "${YURT_RELEASE_POLL_SECS:-5}"
  done
}
