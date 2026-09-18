#!/usr/bin/env bash
# release-playground.sh — cut a playground release train (#78).
#
# One derived label for every artifact, TRAIN = playground-<YYYY.MM.DD>-<kernel7>
# (a second train on the same day and rev gets .2, .3, ...); the artifacts are
# built and published by CI from exact commits (yurt-sandbox's
# release-kernel-wasm.yml and release-native.yml, dispatched on their default
# branch with immutable inputs); this script only sequences the dispatches,
# resolves each run by a correlation id it minted (never "the newest run"),
# generates artifacts/pins.json from the published releases' own sha256
# sidecars, verifies it with scripts/install-pinned-artifacts.sh, opens the
# pin PR, and asks before merging (the merge deploys the page).
#
# The playground image is not part of the train yet (no CI build of the
# ports; #78 part A2): pass the image release to pin with --image-release.
#
# Usage:
#   scripts/release-playground.sh --image-release playground-image-v0.0.8 \
#       [--kernel-sha SHA] [--sandbox-sha SHA] [--train LABEL] [--validate]
#
#   --kernel-sha    yurtos-kernel commit (default: origin/main of ../yurtos-kernel)
#   --sandbox-sha   yurt-sandbox commit  (default: origin/main of ../yurt-sandbox)
#   --image-release the yurt-packages playground-image release to pin (required)
#   --train         the label (default: derived)
#   --validate      publish=false: build everything, publish nothing, pin
#                   nothing; the native run is tested against the kernel wasm
#                   release currently pinned, since the train's does not exist
#   --resume        continue a train from its state file
#   --pins-only     dispatch nothing: regenerate artifacts/pins.json from
#                   existing releases (--kernel-wasm-release,
#                   --desktop-host-release, --yurt-cli-release) and verify
#                   it -- the generator's ground-truth check against a
#                   release cut by hand
#
# State: $XDG_STATE_HOME/yurt-playground/releases/<train>.json (~/.local/state)
# records every step's run id and result; --resume picks up from there. The
# publish jobs fail closed on a tag that already exists, so two operators
# cannot both take a train.
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
kernel_dir=${YURT_KERNEL_ROOT:-$root/../yurtos-kernel}
sandbox_dir=${YURT_SANDBOX_ROOT:-$root/../yurt-sandbox}
sandbox_repo=YurtOS/yurt-sandbox
packages_repo=YurtOS/yurt-packages
state_dir=${XDG_STATE_HOME:-$HOME/.local/state}/yurt-playground/releases

kernel_sha=""
sandbox_sha=""
image_release=""
train=""
validate=0
resume=0
pins_only=0
kernel_wasm_release=""
host_release=""
cli_release=""
while [ $# -gt 0 ]; do
  case $1 in
    --kernel-sha) kernel_sha=$2; shift 2 ;;
    --sandbox-sha) sandbox_sha=$2; shift 2 ;;
    --image-release) image_release=$2; shift 2 ;;
    --train) train=$2; shift 2 ;;
    --validate) validate=1; shift ;;
    --resume) resume=1; shift ;;
    --pins-only) pins_only=1; shift ;;
    --kernel-wasm-release) kernel_wasm_release=$2; shift 2 ;;
    --desktop-host-release) host_release=$2; shift 2 ;;
    --yurt-cli-release) cli_release=$2; shift 2 ;;
    -h|--help) sed -n '2,32p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "release-playground: unknown argument $1" >&2; exit 2 ;;
  esac
done

say() { printf '\033[1m==> %s\033[0m\n' "$*" >&2; }
die() { echo "release-playground: $*" >&2; exit 1; }

for tool in gh jq git; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool is required"
done
gh auth status >/dev/null 2>&1 || die "gh is not logged in"
[ -n "$image_release" ] || die "--image-release is required (the image is not built by the train yet)"
gh release view "$image_release" --repo "$packages_repo" >/dev/null 2>&1 \
  || die "$image_release is not a release of $packages_repo"

# ---- revisions -----------------------------------------------------------
resolve_sha() {
  local dir=$1 given=$2 name=$3
  if [ -n "$given" ]; then
    [[ "$given" =~ ^[0-9a-f]{40}$ ]] || die "--$name must be a full 40-hex SHA"
    echo "$given"
    return
  fi
  [ -d "$dir/.git" ] || die "no checkout at $dir to take origin/main from; pass --$name"
  git -C "$dir" fetch -q origin main
  git -C "$dir" rev-parse origin/main
}
kernel_sha=$(resolve_sha "$kernel_dir" "$kernel_sha" kernel-sha)
sandbox_sha=$(resolve_sha "$sandbox_dir" "$sandbox_sha" sandbox-sha)
say "kernel  $kernel_sha"
say "sandbox $sandbox_sha"
say "image   $image_release"

# ---- the train label -----------------------------------------------------
if [ "$pins_only" = 1 ]; then
  [ -n "$kernel_wasm_release" ] && [ -n "$host_release" ] && [ -n "$cli_release" ] \
    || die "--pins-only needs --kernel-wasm-release, --desktop-host-release and --yurt-cli-release"
  train=${train:-$cli_release}
elif [ -z "$train" ]; then
  base="playground-$(date -u +%Y.%m.%d)-${kernel_sha:0:7}"
  train=$base
  n=1
  while gh release view "kernel-wasm-$train" --repo "$packages_repo" >/dev/null 2>&1; do
    n=$((n + 1))
    train="$base.$n"
  done
fi
if [ "$pins_only" = 0 ]; then
  [[ "$train" =~ ^playground-[0-9]{4}\.[0-9]{2}\.[0-9]{2}-[0-9a-f]{7}(\.[0-9]+)?$ ]] \
    || die "train label $train does not look like playground-YYYY.MM.DD-<rev7>[.N]"
fi
say "train   $train$( [ "$validate" = 1 ] && echo ' (validate: nothing is published)')"
kernel_wasm_release=${kernel_wasm_release:-kernel-wasm-$train}
host_release=${host_release:-desktop-host-$train}
cli_release=${cli_release:-yurt-cli-$train}

if [ "$pins_only" = 0 ]; then
mkdir -p "$state_dir"
state=$state_dir/$train.json
if [ "$resume" = 1 ]; then
  [ -f "$state" ] || die "nothing to resume: $state"
else
  [ -f "$state" ] && [ "$validate" = 0 ] && die "$state exists; --resume it, or pick --train"
  jq -n --arg train "$train" --arg kernel "$kernel_sha" --arg sandbox "$sandbox_sha" \
    --arg image "$image_release" --argjson validate "$validate" \
    '{train:$train, kernel_sha:$kernel, sandbox_sha:$sandbox, image_release:$image, validate:$validate, steps:{}}' \
    > "$state"
fi
step_get() { jq -r ".steps[\"$1\"].$2 // empty" "$state"; }
step_set() { local tmp; tmp=$(mktemp); jq ".steps[\"$1\"].$2 = $3" "$state" > "$tmp" && mv "$tmp" "$state"; }

# ---- dispatch + watch one workflow by correlation id ---------------------
# gh workflow run returns nothing; the run is found by the id stamped in its
# run-name (the workflows set run-name from the correlation_id input).
dispatch_and_watch() {
  local step=$1 workflow=$2; shift 2
  local run_id
  run_id=$(step_get "$step" run_id)
  if [ -z "$run_id" ]; then
    local cid="rel-$(date -u +%Y%m%dT%H%M%SZ)-$RANDOM$RANDOM"
    say "dispatch $workflow ($cid)"
    gh workflow run "$workflow" --repo "$sandbox_repo" --ref main "$@" -f "correlation_id=$cid"
    local tries=0
    while [ -z "$run_id" ]; do
      sleep 5
      run_id=$(gh run list --repo "$sandbox_repo" --workflow "$workflow" --limit 20 \
        --json databaseId,displayTitle --jq ".[] | select(.displayTitle | contains(\"$cid\")) | .databaseId" | head -1)
      tries=$((tries + 1))
      [ "$tries" -lt 24 ] || die "the run for $cid never appeared"
    done
    step_set "$step" run_id "$run_id"
    step_set "$step" correlation_id "\"$cid\""
  fi
  say "watch $workflow run $run_id  (https://github.com/$sandbox_repo/actions/runs/$run_id)"
  if gh run watch "$run_id" --repo "$sandbox_repo" --exit-status >/dev/null; then
    step_set "$step" conclusion '"success"'
  else
    step_set "$step" conclusion '"failure"'
    die "$workflow run $run_id failed; fix and --resume (the step reruns)"
  fi
}

publish_flag=$([ "$validate" = 1 ] && echo false || echo true)

# [1] the kernel wasm
if [ "$(step_get kernel_wasm conclusion)" != success ]; then
  dispatch_and_watch kernel_wasm release-kernel-wasm.yml \
    -f "kernel_sha=$kernel_sha" -f "train=$train" -f "publish=$publish_flag"
fi
if [ "$validate" = 1 ]; then
  # The train's wasm was not published: the native run is tested against
  # the release the page pins today.
  kernel_wasm_release=$(jq -r .kernelWasm.release "$root/artifacts/pins.json")
fi

# [2] the desktop host and the CLI, one run
if [ "$(step_get native conclusion)" != success ]; then
  dispatch_and_watch native release-native.yml \
    -f "sandbox_sha=$sandbox_sha" -f "kernel_sha=$kernel_sha" \
    -f "kernel_wasm_release=$kernel_wasm_release" -f "image_release=$image_release" \
    -f "train=$train" -f "publish=$publish_flag"
fi

if [ "$validate" = 1 ]; then
  say "validated: every artifact of $train built and tested; nothing was published"
  exit 0
fi
fi # pins_only

# [3] pins.json from the releases' own sidecars
sidecar_sha() {
  local tag=$1 asset=$2 dir
  dir=$(mktemp -d "${TMPDIR:-/tmp}/yurt-sidecar.XXXXXX")
  gh release download "$tag" --repo "$packages_repo" --pattern "$asset.sha256" --dir "$dir" --clobber >/dev/null
  cut -d' ' -f1 "$dir/$asset.sha256"
  rm -rf "$dir"
}
say "generate artifacts/pins.json"
kernel_sha256=$(sidecar_sha "$kernel_wasm_release" kernel-wasm.wasm)
image_sha256=$(sidecar_sha "$image_release" playground-image.yurtimg)
image_rev=$(jq -r .image.rev "$root/artifacts/pins.json")
image_rev_note=""
if [ "$image_release" != "$(jq -r .image.release "$root/artifacts/pins.json")" ]; then
  image_rev_note=" (image release changed; check the ports rev by hand)"
fi
host_json='{}'
cli_json='{}'
# The CLI's package names carry its version; the release's asset list says
# which, so the generator never guesses it.
cli_assets=$(gh release view "$cli_release" --repo "$packages_repo" --json assets --jq '.assets[].name')
cli_asset_for() {
  case $1 in
    x86_64-unknown-linux-gnu) grep -E '^yurt_.*_amd64\.deb$' <<< "$cli_assets" ;;
    aarch64-unknown-linux-gnu) grep -E '^yurt_.*_arm64\.deb$' <<< "$cli_assets" ;;
    *) grep -F "yurt-$1.tar.gz" <<< "$cli_assets" | grep -v '\.sha256$' ;;
  esac
}
for target in aarch64-apple-darwin x86_64-apple-darwin x86_64-unknown-linux-gnu aarch64-unknown-linux-gnu; do
  host_json=$(jq --arg t "$target" --arg s "$(sidecar_sha "$host_release" "yurt-desktop-host-$target.tar.gz")" '. + {($t): $s}' <<< "$host_json")
  asset=$(cli_asset_for "$target" | head -1)
  [ -n "$asset" ] || die "$cli_release has no package for $target"
  cli_json=$(jq --arg t "$target" --arg a "$asset" --arg s "$(sidecar_sha "$cli_release" "$asset")" \
    '. + {($t): {asset: $a, sha256: $s}}' <<< "$cli_json")
done
jq -n --arg train "$train" --arg kernel_sha "$kernel_sha" --arg sandbox_sha "$sandbox_sha" \
  --arg kernel_release "$kernel_wasm_release" --arg kernel_sha256 "$kernel_sha256" \
  --arg image_release "$image_release" --arg image_sha256 "$image_sha256" --arg image_rev "$image_rev" \
  --arg host_release "$host_release" --arg cli_release "$cli_release" \
  --argjson host "$host_json" --argjson cli "$cli_json" '{
    train: $train,
    kernelWasm: {repo: "YurtOS/yurtos-kernel", rev: $kernel_sha, release: $kernel_release,
      build: "scripts/build-kernel-wasm.sh", path: "target/kernel-wasm/release/yurt_kernel.wasm", sha256: $kernel_sha256},
    image: {repo: "YurtOS/yurt-ports", rev: $image_rev, release: $image_release,
      build: "ports/playground-image/scripts/package.sh", path: "ports/playground-image/build/dist/playground.yurtimg", sha256: $image_sha256},
    desktopHost: {repo: "YurtOS/yurt-sandbox", rev: $sandbox_sha, release: $host_release,
      build: "scripts/build-desktop-host.sh", sha256: $host},
    yurtCli: {repo: "YurtOS/yurt-sandbox", rev: $sandbox_sha, release: $cli_release,
      build: "scripts/build-yurt-cli.sh",
      assets: ($cli | with_entries(.value = .value.asset)),
      sha256: ($cli | with_entries(.value = .value.sha256))}
  }' > "$root/artifacts/pins.json"
say "verify the pins: scripts/install-pinned-artifacts.sh"
"$root/scripts/install-pinned-artifacts.sh"
if [ "$pins_only" = 1 ]; then
  say "pins regenerated and verified; nothing dispatched, nothing opened"
  exit 0
fi

# [4] the pin PR, merged on a yes
branch="release/$train"
say "open the pin PR on $branch$image_rev_note"
git -C "$root" checkout -q -B "$branch"
git -C "$root" add artifacts/pins.json
git -C "$root" commit -q -m "release: $train

kernel-wasm-$train (yurtos-kernel $kernel_sha), $image_release,
desktop-host-$train and yurt-cli-$train (yurt-sandbox $sandbox_sha)."
git -C "$root" push -q -u origin "$branch"
pr_url=$(gh pr create --repo YurtOS/yurt-playground --base main --head "$branch" \
  --title "release: $train" \
  --body "Pins generated by scripts/release-playground.sh from the train's releases (yurtos-kernel \`$kernel_sha\`, yurt-sandbox \`$sandbox_sha\`, $image_release). Merging deploys the page.")
say "pin PR: $pr_url"
read -r -p "merge $pr_url and deploy? [y/N] " answer
case $answer in
  y|Y|yes) gh pr merge "$pr_url" --squash --delete-branch ;;
  *) say "left open: $pr_url"; exit 0 ;;
esac
say "deploy: gh run list --repo YurtOS/yurt-playground --workflow deploy-pages.yml"
