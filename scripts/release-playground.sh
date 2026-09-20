#!/usr/bin/env bash
# release-playground.sh — cut a playground release train (#78).
#
# One derived label for every artifact, TRAIN = playground-<YYYY.MM.DD>-<kernel7>
# (a second train on the same day and rev gets .2, .3, ...); the artifacts are
# built and published by CI from exact commits (yurt-sandbox's
# release-kernel-wasm.yml and release-native.yml, yurt-ports'
# release-playground-image.yml, each dispatched on its default branch with
# immutable inputs); this script only sequences the dispatches, resolves each
# run by a correlation id it minted (never "the newest run"), generates
# artifacts/pins.json from the published releases' own sha256 sidecars,
# verifies it with scripts/install-pinned-artifacts.sh, opens the pin PR, and
# asks before merging (the merge deploys the page).
#
#   [1] kernel wasm   (yurt-sandbox)  -> kernel-wasm-<TRAIN>
#   [2] image         (yurt-ports)    -> playground-image-<TRAIN> + python-seal-<TRAIN>
#                                        (one run, one ports rev: the sealable
#                                        CPython is relinked from the image's
#                                        cpython build; smoked with [1])
#   [3] native        (yurt-sandbox)  -> desktop-host-<TRAIN> + yurt-cli-<TRAIN>
#                                        (tested against [1] and [2])
#   [4] pins.json from the releases' sidecars, verified, PR, merge on a yes
#
# Usage:
#   scripts/release-playground.sh [--kernel-sha SHA] [--ports-sha SHA] \
#       [--sandbox-sha SHA] [--train LABEL] [--validate]
#
#   --kernel-sha    yurtos-kernel commit (default: origin/main of ../yurtos-kernel)
#   --ports-sha     yurt-ports commit    (default: origin/main of ../yurt-ports)
#   --sandbox-sha   yurt-sandbox commit  (default: origin/main of ../yurt-sandbox)
#   --image-release pin this yurt-packages playground-image release instead
#                   of building one ([2] is skipped; the pythonSeal pin is
#                   carried through unchanged unless --python-seal-release
#                   names a yurt-packages release to pin with it)
#   --train         the label (default: derived)
#   --validate      publish=false: build everything, publish nothing, pin
#                   nothing; the image and native runs are tested against
#                   the kernel wasm and image releases currently pinned,
#                   since the train's do not exist
#   --resume        continue a train from its state file
#   --check         dispatch nothing, write nothing: is everything up to date?
#                   One row per pin (each repo's main vs the pinned rev, the
#                   image and the seal at one rev, the guest SDK the train
#                   would build with, what the deployed page serves, every
#                   pinned release installable); exit 0 = current, 1 = stale,
#                   each STALE row names the step that fixes it
#   --pins-only     dispatch nothing: regenerate artifacts/pins.json from
#                   existing releases (--kernel-wasm-release, --image-release,
#                   --desktop-host-release, --yurt-cli-release, and
#                   --python-seal-release or the carried-through pin) and
#                   verify it -- the generator's ground-truth check against a
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
ports_dir=${YURT_PORTS_ROOT:-$root/../yurt-ports}
sandbox_repo=YurtOS/yurt-sandbox
ports_repo=YurtOS/yurt-ports
packages_repo=YurtOS/yurt-packages
state_dir=${XDG_STATE_HOME:-$HOME/.local/state}/yurt-playground/releases

kernel_sha=""
ports_sha=""
sandbox_sha=""
image_release=""
seal_release=""
train=""
validate=0
resume=0
pins_only=0
check=0
kernel_wasm_release=""
host_release=""
cli_release=""
while [ $# -gt 0 ]; do
  case $1 in
    --kernel-sha) kernel_sha=$2; shift 2 ;;
    --ports-sha) ports_sha=$2; shift 2 ;;
    --sandbox-sha) sandbox_sha=$2; shift 2 ;;
    --image-release) image_release=$2; shift 2 ;;
    --python-seal-release) seal_release=$2; shift 2 ;;
    --train) train=$2; shift 2 ;;
    --validate) validate=1; shift ;;
    --resume) resume=1; shift ;;
    --pins-only) pins_only=1; shift ;;
    --check) check=1; shift ;;
    --kernel-wasm-release) kernel_wasm_release=$2; shift 2 ;;
    --desktop-host-release) host_release=$2; shift 2 ;;
    --yurt-cli-release) cli_release=$2; shift 2 ;;
    -h|--help) sed -n '2,50p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "release-playground: unknown argument $1" >&2; exit 2 ;;
  esac
done

say() { printf '\033[1m==> %s\033[0m\n' "$*" >&2; }
die() { echo "release-playground: $*" >&2; exit 1; }

for tool in gh jq git; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool is required"
done
gh auth status >/dev/null 2>&1 || die "gh is not logged in"

# ---- --check: is everything up to date? (read-only) ------------------------
# One row per thing the train produces or consumes; exit 0 when every row is
# current, 1 when any is stale. Nothing is built, dispatched or written.
# Everything is read from the same places the generator writes and the
# workflows read (pins.json, the repos' main branches, the releases, the
# deployed page), so the answer cannot drift from what a run would do.
run_check() {
  local pins=$root/artifacts/pins.json stale=0
  local playground_repo=YurtOS/yurt-playground
  local toolchain_repo=YurtOS/yurt-toolchain
  local site=${YURT_PLAYGROUND_SITE:-https://yurt-playground.pages.dev}
  main_sha() { gh api "repos/$1/commits/main" --jq .sha; }
  row() {
    # row STATUS NAME PINNED CURRENT NOTE
    local mark
    case $1 in
      ok) mark="ok   " ;;
      stale) mark="STALE"; stale=1 ;;
      *) mark="?    "; stale=1 ;;
    esac
    printf '%s  %-20s %-34s %-34s %s\n' "$mark" "$2" "$3" "$4" "${5:-}"
  }
  short() { echo "${1:0:12}"; }

  local kernel_main ports_main sandbox_main playground_main
  kernel_main=$(main_sha YurtOS/yurtos-kernel)
  ports_main=$(main_sha YurtOS/yurt-ports)
  sandbox_main=$(main_sha YurtOS/yurt-sandbox)
  playground_main=$(main_sha "$playground_repo")

  # The kernel wasm, and the JS host the page bundles at the same rev: a
  # kernel-side change with an unchanged wasm still counts.
  local kernel_pin; kernel_pin=$(jq -r .kernelWasm.rev "$pins")
  if [ "$kernel_pin" = "$kernel_main" ]; then
    row ok "kernel wasm" "$(short "$kernel_pin")" "$(short "$kernel_main")" "yurtos-kernel main"
  else
    row stale "kernel wasm" "$(short "$kernel_pin")" "$(short "$kernel_main")" "yurtos-kernel main moved: [1] kernel wasm, [2] image, [3] native rebuild"
  fi

  # The image and the sealable CPython: one ports rev, and that rev current.
  local image_pin seal_pin; image_pin=$(jq -r .image.rev "$pins"); seal_pin=$(jq -r '.pythonSeal.rev // ""' "$pins")
  if [ "$image_pin" = "$ports_main" ]; then
    row ok "image" "$(short "$image_pin")" "$(short "$ports_main")" "yurt-ports main"
  else
    row stale "image" "$(short "$image_pin")" "$(short "$ports_main")" "yurt-ports main moved: [2] image rebuild"
  fi
  if [ -z "$seal_pin" ]; then
    row stale "python seal" "(none)" "$(short "$image_pin")" "no pythonSeal pin: the notebook kernel has no interpreter"
  elif [ "$seal_pin" = "$image_pin" ]; then
    row ok "python seal" "$(short "$seal_pin")" "$(short "$image_pin")" "same ports rev as the image"
  else
    row stale "python seal" "$(short "$seal_pin")" "$(short "$image_pin")" "not the image's ports rev: [2] rebuilds both"
  fi

  # The desktop host and the CLI.
  local host_pin cli_pin; host_pin=$(jq -r .desktopHost.rev "$pins"); cli_pin=$(jq -r '.yurtCli.rev // ""' "$pins")
  if [ "$host_pin" = "$sandbox_main" ]; then
    row ok "desktop host" "$(short "$host_pin")" "$(short "$sandbox_main")" "yurt-sandbox main"
  else
    row stale "desktop host" "$(short "$host_pin")" "$(short "$sandbox_main")" "yurt-sandbox main moved: [3] native rebuild"
  fi
  if [ -z "$cli_pin" ]; then
    row stale "yurt cli" "(no rev)" "$(short "$sandbox_main")" "pin predates the generator: [3] native rebuild records it"
  elif [ "$cli_pin" = "$sandbox_main" ]; then
    row ok "yurt cli" "$(short "$cli_pin")" "$(short "$sandbox_main")" "yurt-sandbox main"
  else
    row stale "yurt cli" "$(short "$cli_pin")" "$(short "$sandbox_main")" "yurt-sandbox main moved: [3] native rebuild"
  fi

  # The guest SDK behind the image: the train builds the ports with the
  # release yurtos-kernel@main pins in toolchain/sdk.lock. Stale when the
  # lock trails the newest guest-sdk release (run the SDK script, merge the
  # lock bump, then the train), and noted when the pinned image was built
  # against an older lock than main's (a train would move it).
  sdk_lock_at() {
    gh api -H 'Accept: application/vnd.github.raw+json' "repos/YurtOS/yurtos-kernel/contents/toolchain/sdk.lock?ref=$1" \
      | sed -n 's/^guest_sdk_release = "\(.*\)"/\1/p' | head -1
  }
  local sdk_main sdk_pinned sdk_latest
  sdk_main=$(sdk_lock_at "$kernel_main")
  sdk_pinned=$(sdk_lock_at "$kernel_pin")
  sdk_latest=$(gh api "repos/$toolchain_repo/releases" --paginate \
    --jq '[.[] | select(.draft | not) | select(.tag_name | startswith("guest-sdk-v"))] | first | .tag_name')
  if [ "$sdk_main" = "$sdk_latest" ]; then
    row ok "guest sdk (lock)" "$sdk_main" "$sdk_latest" "sdk.lock at yurtos-kernel main names the newest release"
  else
    row stale "guest sdk (lock)" "$sdk_main" "$sdk_latest" "sdk.lock trails the newest release: SDK script first, then the lock bump, then the train"
  fi
  if [ "$sdk_pinned" = "$sdk_main" ]; then
    row ok "guest sdk (image)" "$sdk_pinned" "$sdk_main" "the pinned image's kernel rev locks what main locks"
  else
    row stale "guest sdk (image)" "$sdk_pinned" "$sdk_main" "the pinned image was built with an older SDK: [2] image rebuild"
  fi

  # The deployed page: what the site serves vs pins.json on main, and the
  # commit it was built from. A merged pin PR whose deploy never ran shows
  # here.
  local served_pins served_commit
  served_pins=$(curl -fsS "$site/pins.json" 2>/dev/null || true)
  served_commit=$(curl -fsS "$site/integrity.json" 2>/dev/null | jq -r '.commit // ""' || true)
  local main_pins; main_pins=$(gh api -H 'Accept: application/vnd.github.raw+json' "repos/$playground_repo/contents/artifacts/pins.json?ref=$playground_main")
  if [ -z "$served_pins" ]; then
    row unknown "deployed page" "-" "-" "$site/pins.json did not answer"
  elif [ "$(jq -S . <<< "$served_pins")" = "$(jq -S . <<< "$main_pins")" ]; then
    row ok "deployed pins" "$(jq -r '.train // .image.release' <<< "$main_pins")" "$(jq -r '.train // .image.release' <<< "$served_pins")" "$site serves pins.json as on main"
  else
    row stale "deployed pins" "$(jq -r '.train // .image.release' <<< "$main_pins")" "$(jq -r '.train // .image.release' <<< "$served_pins")" "$site serves other pins than main: deploy pending or failed"
  fi
  if [ -n "$served_commit" ]; then
    if [ "$served_commit" = "$playground_main" ]; then
      row ok "deployed commit" "$(short "$playground_main")" "$(short "$served_commit")" "yurt-playground main is what is deployed"
    else
      row stale "deployed commit" "$(short "$playground_main")" "$(short "$served_commit")" "the page was built from another commit: deploy pending or failed"
    fi
  fi

  # The pins are installable: every release and its sha256 sidecar resolve.
  local key repo tag asset
  for key in kernelWasm image pythonSeal desktopHost yurtCli; do
    repo=$(jq -r ".$key.releaseRepo // \"$packages_repo\"" "$pins")
    tag=$(jq -r ".$key.release // \"\"" "$pins")
    if [ -z "$tag" ]; then
      row stale "release $key" "(none)" "-" "no release pinned"
      continue
    fi
    case $key in
      kernelWasm) asset=kernel-wasm.wasm ;;
      image) asset=playground-image.yurtimg ;;
      pythonSeal) asset=python3-seal.wasm ;;
      desktopHost) asset=yurt-desktop-host-aarch64-apple-darwin.tar.gz ;;
      yurtCli) asset=$(jq -r '.yurtCli.assets["aarch64-apple-darwin"]' "$pins") ;;
    esac
    local names; names=$(gh release view "$tag" --repo "$repo" --json assets --jq '.assets[].name' 2>/dev/null || true)
    if ! grep -qx "$asset" <<< "$names"; then
      row stale "release $key" "$tag" "$asset" "missing in $repo"
    elif ! grep -qx "$asset.sha256" <<< "$names"; then
      # Installable (pins.json carries the sha), but the generator re-pins
      # from sidecars, so a hand-cut release without one cannot be carried
      # into a --pins-only regeneration by tag.
      row ok "release $key" "$tag" "$asset" "$repo (no .sha256 sidecar: cut by hand)"
    else
      row ok "release $key" "$tag" "$asset" "$repo"
    fi
  done

  if [ "$stale" = 0 ]; then
    say "up to date: every pin is at its repo's main, installable, and deployed"
  else
    say "stale: see the STALE rows; --check again after the train"
  fi
  return "$stale"
}

if [ "$check" = 1 ]; then
  command -v curl >/dev/null 2>&1 || die "curl is required for --check"
  run_check
  exit $?
fi

for given in "$image_release" "$seal_release"; do
  [ -z "$given" ] || gh release view "$given" --repo "$packages_repo" >/dev/null 2>&1 \
    || die "$given is not a release of $packages_repo"
done
[ -z "$seal_release" ] || [ -n "$image_release" ] \
  || die "--python-seal-release goes with --image-release (the train builds the two together)"

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
if [ -n "$image_release" ] && [ -z "$ports_sha" ]; then
  # A hand-cut image: its ports rev is whatever pins.json already records,
  # unless --ports-sha says otherwise.
  ports_sha=$(jq -r .image.rev "$root/artifacts/pins.json")
else
  ports_sha=$(resolve_sha "$ports_dir" "$ports_sha" ports-sha)
fi
say "kernel  $kernel_sha"
say "ports   $ports_sha$( [ -n "$image_release" ] && echo " (the image is $image_release, cut by hand)")"
say "sandbox $sandbox_sha"

# ---- the train label -----------------------------------------------------
if [ "$pins_only" = 1 ]; then
  [ -n "$kernel_wasm_release" ] && [ -n "$image_release" ] && [ -n "$host_release" ] && [ -n "$cli_release" ] \
    || die "--pins-only needs --kernel-wasm-release, --image-release, --desktop-host-release and --yurt-cli-release"
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
build_image=$([ -z "$image_release" ] && echo 1 || echo 0)
image_release=${image_release:-playground-image-$train}
[ "$build_image" = 0 ] || seal_release=python-seal-$train
host_release=${host_release:-desktop-host-$train}
cli_release=${cli_release:-yurt-cli-$train}

if [ "$pins_only" = 0 ]; then
mkdir -p "$state_dir"
state=$state_dir/$train.json
if [ "$resume" = 1 ]; then
  [ -f "$state" ] || die "nothing to resume: $state"
else
  [ -f "$state" ] && [ "$validate" = 0 ] && die "$state exists; --resume it, or pick --train"
  jq -n --arg train "$train" --arg kernel "$kernel_sha" --arg ports "$ports_sha" --arg sandbox "$sandbox_sha" \
    --arg image "$image_release" --argjson build_image "$build_image" --argjson validate "$validate" \
    '{train:$train, kernel_sha:$kernel, ports_sha:$ports, sandbox_sha:$sandbox, image_release:$image, build_image:($build_image == 1), validate:$validate, steps:{}}' \
    > "$state"
fi
step_get() { jq -r ".steps[\"$1\"].$2 // empty" "$state"; }
step_set() { local tmp; tmp=$(mktemp); jq ".steps[\"$1\"].$2 = $3" "$state" > "$tmp" && mv "$tmp" "$state"; }

# ---- dispatch + watch one workflow by correlation id ---------------------
# gh workflow run returns nothing; the run is found by the id stamped in its
# run-name (the workflows set run-name from the correlation_id input).
dispatch_and_watch() {
  local step=$1 repo=$2 workflow=$3; shift 3
  local run_id
  run_id=$(step_get "$step" run_id)
  if [ -z "$run_id" ]; then
    local cid="rel-$(date -u +%Y%m%dT%H%M%SZ)-$RANDOM$RANDOM"
    say "dispatch $repo $workflow ($cid)"
    gh workflow run "$workflow" --repo "$repo" --ref main "$@" -f "correlation_id=$cid"
    local tries=0
    while [ -z "$run_id" ]; do
      sleep 5
      run_id=$(gh run list --repo "$repo" --workflow "$workflow" --limit 20 \
        --json databaseId,displayTitle --jq ".[] | select(.displayTitle | contains(\"$cid\")) | .databaseId" | head -1)
      tries=$((tries + 1))
      [ "$tries" -lt 24 ] || die "the run for $cid never appeared"
    done
    step_set "$step" run_id "$run_id"
    step_set "$step" correlation_id "\"$cid\""
  fi
  say "watch $workflow run $run_id  (https://github.com/$repo/actions/runs/$run_id)"
  if gh run watch "$run_id" --repo "$repo" --exit-status >/dev/null; then
    step_set "$step" conclusion '"success"'
  else
    step_set "$step" conclusion '"failure"'
    die "$workflow run $run_id failed; fix and --resume (the step reruns)"
  fi
}

publish_flag=$([ "$validate" = 1 ] && echo false || echo true)

# [1] the kernel wasm
if [ "$(step_get kernel_wasm conclusion)" != success ]; then
  dispatch_and_watch kernel_wasm "$sandbox_repo" release-kernel-wasm.yml \
    -f "kernel_sha=$kernel_sha" -f "train=$train" -f "publish=$publish_flag"
fi
if [ "$validate" = 1 ]; then
  # The train's wasm was not published: the image and native runs are
  # tested against the release the page pins today.
  kernel_wasm_release=$(jq -r .kernelWasm.release "$root/artifacts/pins.json")
fi

# [2] the image and the sealable cpython, one run. The Jupyter payload the
# image overlays is resolved here (the newest jupyter-payload release, the
# rule scripts/install-jupyter-payload.sh follows) so the run's inputs are
# all recorded in the state file.
if [ "$build_image" = 1 ] && [ "$(step_get image conclusion)" != success ]; then
  jupyter_payload=$(step_get image jupyter_payload_release)
  if [ -z "$jupyter_payload" ]; then
    jupyter_payload=$(gh api "repos/$packages_repo/releases" --paginate \
      --jq '[.[] | select(.draft | not) | select(.tag_name | startswith("jupyter-payload"))] | first | .tag_name')
    [ -n "$jupyter_payload" ] && [ "$jupyter_payload" != null ] || die "no jupyter-payload release in $packages_repo"
    step_set image jupyter_payload_release "\"$jupyter_payload\""
  fi
  dispatch_and_watch image "$ports_repo" release-playground-image.yml \
    -f "ports_sha=$ports_sha" -f "kernel_sha=$kernel_sha" \
    -f "kernel_wasm_release=$kernel_wasm_release" -f "jupyter_payload_release=$jupyter_payload" \
    -f "train=$train" -f "publish=$publish_flag"
fi
if [ "$validate" = 1 ] && [ "$build_image" = 1 ]; then
  image_release=$(jq -r .image.release "$root/artifacts/pins.json")
fi

# [3] the desktop host and the CLI, one run
if [ "$(step_get native conclusion)" != success ]; then
  dispatch_and_watch native "$sandbox_repo" release-native.yml \
    -f "sandbox_sha=$sandbox_sha" -f "kernel_sha=$kernel_sha" \
    -f "kernel_wasm_release=$kernel_wasm_release" -f "image_release=$image_release" \
    -f "train=$train" -f "publish=$publish_flag"
fi

if [ "$validate" = 1 ]; then
  say "validated: every artifact of $train built and tested; nothing was published"
  exit 0
fi
fi # pins_only

# [4] pins.json from the releases' own sidecars
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
image_rev_note=""
if [ "$build_image" = 0 ] && [ "$image_release" != "$(jq -r .image.release "$root/artifacts/pins.json")" ]; then
  image_rev_note=" (image release changed by hand; check the ports rev)"
fi
# The sealable CPython: the train's, from the image run's own sidecar; with
# a hand-cut image, the release named on the command line, or else the pin
# carried through unchanged (it must exist: the notebook kernel needs it).
if [ -n "$seal_release" ]; then
  python_seal_json=$(jq -n --arg ports "$ports_sha" --arg release "$seal_release" \
    --arg sha "$(sidecar_sha "$seal_release" python3-seal.wasm)" \
    '{repo: "YurtOS/yurt-ports", rev: $ports, release: $release, build: "ports/cpython/scripts/build-seal.sh", sha256: $sha}')
else
  python_seal_json=$(jq -c '.pythonSeal // empty' "$root/artifacts/pins.json")
  [ -n "$python_seal_json" ] || die "artifacts/pins.json has no pythonSeal entry to carry through; pass --python-seal-release"
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
  --arg image_release "$image_release" --arg image_sha256 "$image_sha256" --arg ports_sha "$ports_sha" \
  --arg host_release "$host_release" --arg cli_release "$cli_release" \
  --argjson host "$host_json" --argjson cli "$cli_json" --argjson python_seal "$python_seal_json" '{
    train: $train,
    kernelWasm: {repo: "YurtOS/yurtos-kernel", rev: $kernel_sha, release: $kernel_release,
      build: "scripts/build-kernel-wasm.sh", path: "target/kernel-wasm/release/yurt_kernel.wasm", sha256: $kernel_sha256},
    image: {repo: "YurtOS/yurt-ports", rev: $ports_sha, release: $image_release,
      build: "scripts/build-playground-image.sh", path: "ports/playground-image/build/dist/playground.yurtimg", sha256: $image_sha256},
    desktopHost: {repo: "YurtOS/yurt-sandbox", rev: $sandbox_sha, release: $host_release,
      build: "scripts/build-desktop-host.sh", sha256: $host},
    yurtCli: {repo: "YurtOS/yurt-sandbox", rev: $sandbox_sha, release: $cli_release,
      build: "scripts/build-yurt-cli.sh",
      assets: ($cli | with_entries(.value = .value.asset)),
      sha256: ($cli | with_entries(.value = .value.sha256))},
    pythonSeal: $python_seal
  }' > "$root/artifacts/pins.json"
say "verify the pins: scripts/install-pinned-artifacts.sh"
"$root/scripts/install-pinned-artifacts.sh"
if [ "$pins_only" = 1 ]; then
  say "pins regenerated and verified; nothing dispatched, nothing opened"
  exit 0
fi

# [4] the pin PR, merged on a yes -- on a checkout with nothing else in it
[ -z "$(git -C "$root" status --porcelain --untracked-files=no | grep -v ' artifacts/pins.json$')" ] \
  || die "the playground checkout has uncommitted changes; commit or stash them first"
branch="release/$train"
say "open the pin PR on $branch$image_rev_note"
git -C "$root" checkout -q -B "$branch"
git -C "$root" add artifacts/pins.json
git -C "$root" commit -q -m "release: $train

kernel-wasm-$train (yurtos-kernel $kernel_sha), $image_release and
$(jq -r .pythonSeal.release "$root/artifacts/pins.json") (yurt-ports $ports_sha),
desktop-host-$train and yurt-cli-$train (yurt-sandbox $sandbox_sha)."
git -C "$root" push -q -u origin "$branch"
pr_url=$(gh pr create --repo YurtOS/yurt-playground --base main --head "$branch" \
  --title "release: $train" \
  --body "Pins generated by scripts/release-playground.sh from the train's releases (yurtos-kernel \`$kernel_sha\`, yurt-ports \`$ports_sha\`, yurt-sandbox \`$sandbox_sha\`). Merging deploys the page.")
say "pin PR: $pr_url"
read -r -p "merge $pr_url and deploy? [y/N] " answer
case $answer in
  y|Y|yes) gh pr merge "$pr_url" --squash --delete-branch ;;
  *) say "left open: $pr_url"; exit 0 ;;
esac
say "deploy: gh run list --repo YurtOS/yurt-playground --workflow deploy-pages.yml"
