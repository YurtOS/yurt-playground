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

# kernel_gh ARGS...: run gh, its output in kernel_gh_out. On failure,
# status 1 for an HTTP 404, 2 for an error worth another look (a 429, a
# 5xx, no answer at all), and a stop for any other.
kernel_gh() {
  local err msg
  err=$(mktemp)
  if kernel_gh_out=$(gh "$@" 2>"$err"); then
    rm -f "$err"
    return 0
  fi
  msg=$(cat "$err")
  rm -f "$err"
  case $msg in
    *"HTTP 404"*) return 1 ;;
    *"HTTP 429"* | *"HTTP 5"[0-9][0-9]*) ;;
    *"HTTP "[0-9][0-9][0-9]*) die "gh $1 $2 failed: $msg; fix it, then $(resume_command)" ;;
  esac
  say "gh $1 $2 failed, looking again: $msg"
  return 2
}

# Wait for yurtos-kernel's release of TAG (at SHA): pushing a kernel-v*
# tag starts release-kernel.yml, which takes minutes to publish it, and
# yurt-sandbox's release-kernel-wasm.yml fails on a tag with no release yet
# (#326). The release is looked up the way that workflow does. Stops when
# the push's run fails, when 24 looks (2 minutes) find no run in progress
# and no release, and after YURT_KERNEL_RELEASE_TIMEOUT_SECS (30 minutes)
# in any case.
wait_for_kernel_release() {
  local tag=$1 sha=$2 timeout=${YURT_KERNEL_RELEASE_TIMEOUT_SECS:-1800}
  local start=$SECONDS idle=0 run="" shown=- rc
  [[ "$timeout" =~ ^[0-9]+$ ]] || die "YURT_KERNEL_RELEASE_TIMEOUT_SECS must be a whole number of seconds"
  while :; do
    rc=0
    kernel_gh api "repos/YurtOS/yurtos-kernel/releases/tags/$tag" --jq .draft || rc=$?
    [ "$rc" = 0 ] && [ "$kernel_gh_out" = false ] && return
    # The run of the tag's push at SHA: not a build-only workflow_dispatch
    # on the tag, nor the run of an earlier push of the same tag.
    rc=0
    kernel_gh run list --repo YurtOS/yurtos-kernel --workflow release-kernel.yml --branch "$tag" \
      --event push --limit 20 --json status,conclusion,url,headSha \
      --jq '[.[] | select(.headSha == "'"$sha"'")][0] // empty
        | "\(.status) \(if (.conclusion // "") == "" then "-" else .conclusion end) \(.url)"' || rc=$?
    [ "$rc" = 1 ] && die "yurtos-kernel has no release-kernel.yml workflow to publish $tag"
    if [ "$rc" = 0 ]; then
      run=$kernel_gh_out
      case $run in
        "completed success "* | "") idle=$((idle + 1)) ;;
        "completed "*)
          run=${run#completed }
          die "yurtos-kernel release-kernel.yml for $tag ended ${run%% *} (${run#* }), so it has no release; fix it, then $(resume_command)" ;;
        *) idle=0 ;;
      esac
    fi
    if [ "$idle" -ge 24 ]; then
      [ -n "$run" ] \
        && die "yurtos-kernel release-kernel.yml for $tag succeeded (${run##* }) but published no release; publish it, then $(resume_command)"
      die "yurtos-kernel has no release-kernel.yml run for the push of $tag at ${sha:0:7}, so no release is coming; publish it, then $(resume_command)"
    fi
    [ $((SECONDS - start)) -lt "$timeout" ] \
      || die "yurtos-kernel's release of $tag is not published after ${timeout}s (release-kernel.yml: ${run:-no run}); once it is, $(resume_command)"
    [ "$run" = "$shown" ] || say "waiting for yurtos-kernel's release of $tag (release-kernel.yml: ${run:-no run yet})"
    shown=$run
    sleep "${YURT_RELEASE_POLL_SECS:-5}"
  done
}
