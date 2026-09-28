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
