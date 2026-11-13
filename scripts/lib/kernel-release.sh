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

# Whether yurtos-kernel has published its release of TAG, by the check
# yurt-sandbox's release-kernel-wasm.yml makes. GitHub answers 404 for a
# tag with no published release; any other error stops the train.
kernel_release_published() {
  local tag=$1 err draft msg
  err=$(mktemp)
  if draft=$(gh api "repos/YurtOS/yurtos-kernel/releases/tags/$tag" --jq .draft 2>"$err"); then
    rm -f "$err"
    [ "$draft" = false ]
    return
  fi
  msg=$(cat "$err")
  rm -f "$err"
  case $msg in *"HTTP 404"*) return 1 ;; esac
  die "could not look up yurtos-kernel's release of $tag: $msg"
}

# Wait for yurtos-kernel's release of TAG: pushing a kernel-v* tag starts
# release-kernel.yml, which takes minutes to publish it, and yurt-sandbox's
# release-kernel-wasm.yml fails on a tag with no release yet (#326). Stops
# when the tag's run ends without a release, when no run has started after
# 2 minutes (the tag push started none), and after
# YURT_KERNEL_RELEASE_TIMEOUT_SECS (30 minutes) in any case.
wait_for_kernel_release() {
  local tag=$1 timeout=${YURT_KERNEL_RELEASE_TIMEOUT_SECS:-1800} start=$SECONDS run shown=-
  [[ "$timeout" =~ ^[0-9]+$ ]] || die "YURT_KERNEL_RELEASE_TIMEOUT_SECS must be a whole number of seconds"
  while ! kernel_release_published "$tag"; do
    # The tag push's run, not a build-only workflow_dispatch on the tag.
    run=$(gh run list --repo YurtOS/yurtos-kernel --workflow release-kernel.yml --branch "$tag" \
      --event push --limit 1 --json status,conclusion,url \
      --jq '.[0] // empty | [.status, .conclusion, .url] | map(select(. != "" and . != null)) | join(" ")') \
      || die "could not list yurtos-kernel's release-kernel.yml runs for $tag"
    case $run in
      "completed success "*)
        kernel_release_published "$tag" && return
        die "yurtos-kernel release-kernel.yml for $tag succeeded (${run##* }) but published no release; publish it, then $(resume_command)" ;;
      "completed "*)
        run=${run#completed }
        die "yurtos-kernel release-kernel.yml for $tag ended ${run%% *} (${run#* }), so it has no release; fix it, then $(resume_command)" ;;
      "")
        [ $((SECONDS - start)) -lt 120 ] && [ $((SECONDS - start)) -lt "$timeout" ] \
          || die "yurtos-kernel has no release-kernel.yml run for the push of $tag, so no release is coming; push the tag again, then $(resume_command)" ;;
    esac
    [ $((SECONDS - start)) -lt "$timeout" ] \
      || die "yurtos-kernel's release of $tag is not published after ${timeout}s (release-kernel.yml: $run); once it is, $(resume_command)"
    [ "$run" = "$shown" ] || say "waiting for yurtos-kernel's release of $tag (${run:-no release-kernel.yml run yet})"
    shown=$run
    sleep "${YURT_RELEASE_POLL_SECS:-5}"
  done
}
