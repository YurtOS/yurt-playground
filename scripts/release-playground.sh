#!/usr/bin/env bash
# release-playground.sh — cut a playground release train (#78).
#
# One derived label for every artifact, TRAIN = playground-<YYYY.MM.DD>-<kernel7>
# (a second train on the same day and rev gets .2, .3, ...); the artifacts are
# built and published by CI from exact commits (yurt-sandbox's
# release-kernel-wasm.yml and release-native.yml, yurt-ports'
# release-playground-image.yml, each dispatched on its default branch --
# or, for a rehearsal of commits off main, on a validate branch, see
# --validate -- with immutable inputs), each as a release of the repository that built it --
# no cross-repo write token exists; this script only sequences the
# dispatches, resolves each run by a correlation id it minted (never "the
# newest run"), generates artifacts/pins.json from the published releases'
# own sha256 sidecars (every pin records its releaseRepo), verifies it with
# scripts/install-pinned-artifacts.sh, opens the pin PR, and asks before
# merging (the merge deploys the page).
#
#   [1] kernel wasm   (yurt-sandbox)  -> kernel-wasm-<TRAIN>
#   [2] image         (yurt-ports)    -> playground-image-<TRAIN> + python-seal-<TRAIN>
#                                        (one run, one ports rev: the sealable
#                                        CPython is relinked from the image's
#                                        cpython build; smoked through the
#                                        CLI pins.json records today)
#   [3] native        (yurt-sandbox)  -> desktop-host-<TRAIN> + yurt-cli-<TRAIN>
#                                        (tested against [1] and [2])
#   [4] pins.json from the releases' sidecars, verified, PR, merge on a yes
#                                        (the merge deploys the page)
#   [5] desktop       (yurt-playground) -> desktop-<TRAIN>: the installers,
#                                        built from the merge commit, the
#                                        release the home page's download
#                                        links resolve to
#
# Usage:
#   scripts/release-playground.sh [--kernel-sha SHA] [--ports-sha SHA] \
#       [--sandbox-sha SHA] [--train LABEL] [--validate]
#
#   --kernel-sha    yurtos-kernel commit (default: origin/main of ../yurtos-kernel)
#   --ports-sha     yurt-ports commit    (default: origin/main of ../yurt-ports)
#   --sandbox-sha   yurt-sandbox commit  (default: origin/main of ../yurt-sandbox)
#                   Each commit is checked against its checkout's origin/main
#                   (YURT_KERNEL_ROOT, YURT_PORTS_ROOT, YURT_SANDBOX_ROOT
#                   override the paths), so the checkouts must exist
#   --image-release pin this playground-image release instead of building
#                   one ([2] is skipped; the pythonSeal pin is carried
#                   through unchanged unless --python-seal-release names a
#                   release to pin with it). A release is `tag` (in
#                   YurtOS/yurt-packages, where the hand-cut ones live) or
#                   `owner/repo@tag` (a previous train's, in its own repo)
#   --train         the label (default: derived)
#   --validate      a rehearsal: the train is labelled <TRAIN>-validate and
#                   published like any other -- as prereleases in the
#                   builders' repositories, so every step tests against
#                   the train's own artifacts (the pinned ones may be a
#                   kernel rev behind the runtime) -- then the prereleases
#                   are deleted; nothing is pinned, no PR is opened.
#                   One exception: the image ([2]) is built from main's
#                   workflow only when --ports-sha and --kernel-sha are both
#                   in their repositories' main history. Otherwise [2] runs
#                   from a validate/<TRAIN> branch of yurt-ports made at its
#                   main's head (deleted at the end) with publish=false: it
#                   builds and smokes the image but publishes nothing, and
#                   [3] tests against the image artifacts/pins.json pins.
#                   Likewise the host and CLI ([3]) build from main's
#                   workflow only when --sandbox-sha and --kernel-sha are
#                   both in their repositories' main history; otherwise [3]
#                   runs from a validate/<TRAIN> branch of yurt-sandbox made
#                   at its main's head (deleted at the end) with
#                   publish=false.
#                   A train that is not a rehearsal needs all three on main
#                   and stops before its first dispatch otherwise.
#   --resume        continue a train from its state file. Without --train,
#                   only the newest train of its kind (add --validate for a
#                   rehearsal) and only if it started today; a failure
#                   prints the exact command to resume it
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
# The hand-cut releases; a train's are in the repositories that built them.
packages_repo=YurtOS/yurt-packages
state_dir=${XDG_STATE_HOME:-$HOME/.local/state}/yurt-playground/releases

# The header comment above, whole: every line that starts with `#` from
# line 2 until the first line that does not.
usage() {
  sed -n '2,/^[^#]/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'
}

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
    -h|--help|help|—help|–help) usage; exit 0 ;;
    *) echo "release-playground: unknown argument $1" >&2; exit 2 ;;
  esac
done

say() { printf '\033[1m==> %s\033[0m\n' "$*" >&2; }
die() { echo "release-playground: $*" >&2; exit 1; }
# The command that resumes this train, spelled out: a rehearsal needs
# --validate as well, and a bare --resume picks the newest *real* train,
# which once resumed an abandoned one instead of the rehearsal that failed.
resume_command() {
  printf 'scripts/release-playground.sh --resume --train %s%s' \
    "${train%-validate}" "$( [ "$validate" = 1 ] && echo ' --validate')"
}
source "$root/scripts/lib/kernel-release.sh"
source "$root/scripts/lib/snapshot-pin.sh"

for tool in gh jq git deno; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool is required"
done
gh auth status >/dev/null 2>&1 || die "gh is not logged in"

# A release given on the command line: `tag` (yurt-packages) or `owner/repo@tag`.
release_repo() { case $1 in */*@*) echo "${1%%@*}" ;; *) echo "$packages_repo" ;; esac; }
release_tag() { echo "${1##*@}"; }

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

for given in "$image_release" "$seal_release" "$kernel_wasm_release" "$host_release" "$cli_release"; do
  [ -z "$given" ] || gh release view "$(release_tag "$given")" --repo "$(release_repo "$given")" >/dev/null 2>&1 \
    || die "$given is not a release of $(release_repo "$given")"
done
[ -z "$seal_release" ] || [ -n "$image_release" ] \
  || die "--python-seal-release goes with --image-release (the train builds the two together)"

# ---- a resumed train is the state file's ----------------------------------
# The revisions, the image and the label come from the record, never from
# the checkouts: main has moved since the train started, and a step
# dispatched at today's revision would not match the artifacts already built.
if [ "$resume" = 1 ] && [ "$pins_only" = 0 ]; then
  if [ -z "$train" ]; then
    # Newest first by modification time: every step rewrites its train's
    # state file, so the file written last is the train last worked on.
    # Labels do not order by time (X-validate sorts after X, and two trains
    # on one day fall back to the order of their kernel shas).
    newest="" train=""
    while IFS= read -r file; do
      [ -n "$file" ] || continue
      label=$(jq -r .train "$file")
      [ -n "$newest" ] || newest=$label
      if [ -z "$train" ] && jq -e --argjson v "$validate" \
        'select(.validate == $v and (.train | endswith("-validate")) == ($v == 1))' \
        "$file" >/dev/null; then
        train=$label
      fi
    done < <(ls -t "$state_dir"/*.json 2>/dev/null)
    # Without --train, resume only the train that is plainly meant: the
    # newest one of its kind, started today. A rehearsal newer than every
    # real train means the caller forgot --validate.
    if [ "$validate" = 0 ] && [[ "$newest" == *-validate ]] && [ "$newest" != "$train" ]; then
      die "the newest train is the rehearsal $newest; resume it with: scripts/release-playground.sh --resume --train ${newest%-validate} --validate"
    fi
    [ -n "$train" ] || die "nothing to resume$( [ "$validate" = 1 ] && echo ' (rehearsal)'); pass --train"
    today=$(date -u +%Y.%m.%d)
    [[ "$train" == "playground-$today-"* ]] \
      || die "the newest $( [ "$validate" = 1 ] && echo rehearsal || echo train), $train, did not start today ($today); to resume it anyway: $(resume_command)"
  fi
  train=${train%-validate}; [ "$validate" = 0 ] || train="$train-validate"
  state=$state_dir/$train.json
  [ -f "$state" ] || die "nothing to resume: $state"
  for var in kernel_sha ports_sha sandbox_sha; do
    recorded=$(jq -r ".$var" "$state")
    [ -z "${!var}" ] || [ "${!var}" = "$recorded" ] || die "--${var//_/-} ${!var} is not the train's ($recorded)"
    printf -v "$var" '%s' "$recorded"
  done
  # A hand-cut image (and its seal) as given, `owner/repo@tag`: a bare tag
  # would resolve to yurt-packages, and a seal left out would carry the old
  # pin through. State files from before image_repo recorded only the tag.
  if [ "$(jq -r .build_image "$state")" != true ]; then
    image_release=$(jq -r 'if .image_repo then "\(.image_repo)@\(.image_release)" else .image_release end' "$state")
    seal_release=$(jq -r 'if (.seal_release // "") != "" then "\(.seal_repo)@\(.seal_release)" else "" end' "$state")
  fi
fi

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
  while gh release view "kernel-wasm-$train" --repo "$sandbox_repo" >/dev/null 2>&1; do
    n=$((n + 1))
    train="$base.$n"
  done
fi
if [ "$pins_only" = 0 ]; then
  [[ "$train" == *-validate ]] && [ "$validate" = 0 ] && die "train label $train is a rehearsal's; pass --validate"
  train=${train%-validate}
  [[ "$train" =~ ^playground-[0-9]{4}\.[0-9]{2}\.[0-9]{2}-[0-9a-f]{7}(\.[0-9]+)?$ ]] \
    || die "train label $train does not look like playground-YYYY.MM.DD-<rev7>[.N]"
  if [ "$validate" = 1 ]; then
    train="$train-validate"
    # The prereleases a rehearsal publishes, as repo:tag, deleted at the end.
    rehearsal_releases=("$sandbox_repo:kernel-wasm-$train" "$sandbox_repo:desktop-host-$train" "$sandbox_repo:yurt-cli-$train"
      "$ports_repo:playground-image-$train" "$ports_repo:python-seal-$train")
    if [ "$resume" = 0 ]; then
      for spec in "${rehearsal_releases[@]}"; do
        gh release view "${spec#*:}" --repo "${spec%%:*}" >/dev/null 2>&1 \
          && die "${spec%%:*} still has ${spec#*:} from an unfinished rehearsal; resume it ($(resume_command)), or delete them (gh release delete ${spec#*:} --repo ${spec%%:*} --yes --cleanup-tag)"
      done
    fi
  fi
fi
say "train   $train$( [ "$validate" = 1 ] && echo ' (validate: prereleases, deleted at the end)')"
build_image=$([ -z "$image_release" ] && echo 1 || echo 0)
kernel_wasm_repo=$(release_repo "${kernel_wasm_release:-$sandbox_repo@x}")
kernel_wasm_release=$(release_tag "${kernel_wasm_release:-kernel-wasm-$train}")
image_repo=$(release_repo "${image_release:-$ports_repo@x}")
image_release=$(release_tag "${image_release:-playground-image-$train}")
if [ "$build_image" = 1 ]; then
  seal_repo=$ports_repo
  seal_release=python-seal-$train
elif [ -n "$seal_release" ]; then
  seal_repo=$(release_repo "$seal_release")
  seal_release=$(release_tag "$seal_release")
fi
host_repo=$(release_repo "${host_release:-$sandbox_repo@x}")
host_release=$(release_tag "${host_release:-desktop-host-$train}")
cli_repo=$(release_repo "${cli_release:-$sandbox_repo@x}")
cli_release=$(release_tag "${cli_release:-yurt-cli-$train}")

# ---- where the image builds ([2]) -----------------------------------------
# yurt-ports' release-playground-image.yml refuses, from main, any ports or
# kernel commit outside their repositories' main history: a job on main's
# ref can write the cache every release restores. Such commits build from a
# validate/<train> branch instead, which can write only its own scope, and
# publish nothing. Decided when the train starts (so a real train stops
# before its first dispatch) and recorded in the state file.
image_ref=main
image_publish=true
# on_main DIR SHA: SHA is in the history of DIR's origin/main.
# A missing checkout or a failed fetch stops the train: it says nothing
# about the commit, and must not pass for "off main".
on_main() {
  git -C "$1" rev-parse --git-dir >/dev/null 2>&1 \
    || die "no checkout at $1 to check $2 against its main; clone it there or set its *_ROOT variable"
  git -C "$1" fetch -q origin main 2>/dev/null || die "could not fetch origin main in $1"
  git -C "$1" merge-base --is-ancestor "$2" origin/main 2>/dev/null
}
decide_image_ref() {
  local off_main=""
  on_main "$ports_dir" "$ports_sha" || off_main="yurt-ports $ports_sha (checkout: $ports_dir)"
  on_main "$kernel_dir" "$kernel_sha" || off_main="${off_main:+$off_main, }yurtos-kernel $kernel_sha (checkout: $kernel_dir)"
  image_ref=main
  image_publish=true
  [ -n "$off_main" ] || return 0
  [ "$validate" = 1 ] || die "not in main's history: $off_main. A train's image builds only from both mains; rehearse it with --validate"
  image_ref=validate/$train
  image_publish=false
  say "image   built from yurt-ports $image_ref, not published ($off_main not on main); [3] tests against the pinned image"
}
if [ "$pins_only" = 0 ] && [ "$build_image" = 1 ] && [ "$resume" = 0 ]; then
  decide_image_ref
  if [ "$image_ref" != main ] && gh api "repos/$ports_repo/git/refs/heads/$image_ref" >/dev/null 2>&1; then
    die "$ports_repo still has the branch $image_ref from an unfinished rehearsal; resume it ($(resume_command)), or delete it (gh api -X DELETE repos/$ports_repo/git/refs/heads/$image_ref)"
  fi
fi

# ---- where the host and CLI build ([3]) -----------------------------------
# yurt-sandbox's release-native.yml builds, from main, only sandbox and
# kernel commits in their repositories' main history (it builds both).
# Other commits build from a validate/<train> branch instead, and publish
# nothing. Decided when the train starts, for every train that dispatches
# (so a real train with either commit off main stops before its first
# dispatch, [1] included, whether or not it builds an image), and recorded
# in the state file (a resumed train from before that record decides when
# it resumes).
native_ref=main
native_publish=true
decide_native_ref() {
  local off_main=""
  on_main "$sandbox_dir" "$sandbox_sha" || off_main="yurt-sandbox $sandbox_sha (checkout: $sandbox_dir)"
  on_main "$kernel_dir" "$kernel_sha" || off_main="${off_main:+$off_main, }yurtos-kernel $kernel_sha (checkout: $kernel_dir)"
  native_ref=main
  native_publish=true
  [ -n "$off_main" ] || return 0
  [ "$validate" = 1 ] || die "not in main's history: $off_main. A train's host and CLI build only from both mains; rehearse it with --validate"
  native_ref=validate/$train
  native_publish=false
  say "native  built from yurt-sandbox $native_ref, not published ($off_main not on main)"
}
if [ "$pins_only" = 0 ] && [ "$resume" = 0 ]; then
  decide_native_ref
  if [ "$native_ref" != main ] && gh api "repos/$sandbox_repo/git/refs/heads/$native_ref" >/dev/null 2>&1; then
    die "$sandbox_repo still has the branch $native_ref from an unfinished rehearsal; resume it ($(resume_command)), or delete it (gh api -X DELETE repos/$sandbox_repo/git/refs/heads/$native_ref)"
  fi
fi

# [2]'s smoke installs the CLI pins.json records today (not the train's
# own, cli_release, which [3] publishes and [4] pins), its amd64 .deb, and
# the image workflow refuses a yurt_cli_release without that .deb's sha256
# (yurt_cli_sha256). Read them from pins.json before the state file is
# written and before [1] spends a run, and stop on a missing or malformed
# digest rather than dispatch an empty one. They are read on every run, a
# --resume included, since the state file does not record them.
pinned_cli_for_image() {
  local pins=$root/artifacts/pins.json linux=x86_64-unknown-linux-gnu asset
  [ -f "$pins" ] || die "no $pins to read [2]'s smoke CLI from"
  read_pin() { jq -r --arg t "$linux" "$1 // empty" "$pins" 2>/dev/null \
    || die "artifacts/pins.json: cannot read $1 for [2]'s smoke CLI"; }
  smoke_cli_release=$(read_pin '.yurtCli.release?')
  smoke_cli_repo=$(read_pin '.yurtCli.releaseRepo?')
  smoke_cli_repo=${smoke_cli_repo:-$packages_repo}
  asset=$(read_pin '.yurtCli.assets?[$t]?')
  smoke_cli_sha256=$(read_pin '.yurtCli.sha256?[$t]?')
  [ -n "$smoke_cli_release" ] || die "artifacts/pins.json names no yurtCli.release for [2]'s smoke"
  # The digest must be the .deb's the smoke downloads, not a tarball's.
  [[ "$asset" == yurt_*_amd64.deb ]] \
    || die "artifacts/pins.json yurtCli.assets[\"$linux\"] is '$asset', not the amd64 .deb [2]'s smoke installs"
  [[ "$smoke_cli_sha256" =~ ^[0-9a-f]{64}$ ]] \
    || die "artifacts/pins.json has no sha256 (64 lowercase hex) for $smoke_cli_release's $asset (yurtCli.sha256[\"$linux\"]); [2] needs it as yurt_cli_sha256"
}
if [ "$pins_only" = 0 ] && [ "$build_image" = 1 ] \
  && { [ "$resume" = 0 ] || [ "$(jq -r '.steps.image.conclusion // empty' "$state")" != success ]; }; then
  pinned_cli_for_image
fi

if [ "$pins_only" = 0 ]; then
mkdir -p "$state_dir"
state=$state_dir/$train.json
if [ "$resume" = 1 ]; then
  [ -f "$state" ] || die "nothing to resume: $state"
else
  [ -f "$state" ] && die "$state exists; --resume it, or pick --train"
  jq -n --arg train "$train" --arg kernel "$kernel_sha" --arg ports "$ports_sha" --arg sandbox "$sandbox_sha" \
    --arg image "$image_release" --arg image_repo "$image_repo" --argjson build_image "$build_image" --argjson validate "$validate" \
    --arg seal "${seal_release:-}" --arg seal_repo "${seal_repo:-}" \
    '{train:$train, kernel_sha:$kernel, ports_sha:$ports, sandbox_sha:$sandbox, image_release:$image, image_repo:$image_repo,
      seal_release:$seal, seal_repo:$seal_repo, build_image:($build_image == 1), validate:$validate, steps:{}}' \
    > "$state"
fi
step_get() { jq -r ".steps[\"$1\"].$2 // empty" "$state"; }
step_set() { local tmp; tmp=$(mktemp); jq ".steps[\"$1\"].$2 = $3" "$state" > "$tmp" && mv "$tmp" "$state"; }
# The image's ref: a new train's, decided above; a resumed train's, the one
# recorded when it started (a state file from before this record decides
# at [2]).
if [ "$build_image" = 1 ]; then
  if [ "$resume" = 0 ]; then
    step_set image ref "\"$image_ref\""
  elif [ -n "$(step_get image ref)" ]; then
    image_ref=$(step_get image ref)
    [ "$image_ref" = main ] || image_publish=false
  fi
fi
# The host and CLI's ref, the same way; a resumed train whose state file
# predates this record (and whose [3] has not run) decides now, before any
# dispatch.
if [ "$resume" = 0 ]; then
  step_set native ref "\"$native_ref\""
elif [ -n "$(step_get native ref)" ]; then
  native_ref=$(step_get native ref)
  [ "$native_ref" = main ] || native_publish=false
elif [ "$(step_get native conclusion)" != success ]; then
  decide_native_ref
  step_set native ref "\"$native_ref\""
fi

# ---- dispatch + watch one workflow by correlation id ---------------------
# gh workflow run returns nothing; the run is found by the id stamped in its
# run-name (the workflows set run-name from the correlation_id input).
dispatch_and_watch() {
  local step=$1 repo=$2 workflow=$3; shift 3
  local ref=main
  if [ "${1:-}" = "--ref" ]; then
    ref=$2
    shift 2
  fi
  local kernel_sha_to_resolve=""
  if [ "${1:-}" = "--resolve-kernel-release" ]; then
    kernel_sha_to_resolve=$2
    shift 2
  fi
  local run_id
  run_id=$(step_get "$step" run_id)
  # A recorded run that finished without success (failed, cancelled) is
  # what --resume is for: forget it and dispatch again.
  if [ -n "$run_id" ]; then
    local status
    status=$(gh run view "$run_id" --repo "$repo" --json status,conclusion --jq '"\(.status)/\(.conclusion)"')
    case $status in
      completed/success) ;;
      completed/*) say "run $run_id ended ${status#completed/}; dispatching again"; run_id="" ;;
    esac
  fi
  if [ -z "$run_id" ]; then
    if [ -n "$kernel_sha_to_resolve" ]; then
      local kernel_release
      kernel_release=$(resolve_kernel_release "$kernel_dir" "$kernel_sha_to_resolve")
      say "kernel release $kernel_release"
      set -- "$@" -f "kernel_release=$kernel_release"
    fi
    local cid="rel-$(date -u +%Y%m%dT%H%M%SZ)-$RANDOM$RANDOM"
    say "dispatch $repo $workflow on $ref ($cid)"
    gh workflow run "$workflow" --repo "$repo" --ref "$ref" "$@" -f "correlation_id=$cid"
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
    die "$workflow run $run_id failed; fix it, then $(resume_command) (the step reruns)"
  fi
}

# A rehearsal publishes too (prereleases, see --validate): the runs test
# against the train's own artifacts either way.


# [1] the kernel wasm
if [ "$(step_get kernel_wasm conclusion)" != success ]; then
  dispatch_and_watch kernel_wasm "$sandbox_repo" release-kernel-wasm.yml \
    --resolve-kernel-release "$kernel_sha" -f "train=$train" -f "publish=true"
fi

# [2] the image and the sealable cpython, one run. The Jupyter payload the
# image overlays is resolved here (the newest jupyter-payload release, the
# rule scripts/install-jupyter-payload.sh follows) so the run's inputs are
# all recorded in the state file. The smoke boots the image through the
# yurt CLI the page pins today; the train's own CLI is tested against the
# image in [3].
# A published image goes through yurt-ports' protected `release`
# environment: when it requires a reviewer, the watch below waits for that
# approval.
if [ "$build_image" = 1 ] && [ "$(step_get image conclusion)" != success ]; then
  if [ -z "$(step_get image ref)" ]; then
    decide_image_ref
    step_set image ref "\"$image_ref\""
  fi
  jupyter_payload=$(step_get image jupyter_payload_release)
  if [ -z "$jupyter_payload" ]; then
    jupyter_payload=$(gh api "repos/$packages_repo/releases" --paginate \
      --jq '[.[] | select(.draft | not) | select(.tag_name | startswith("jupyter-payload"))] | first | .tag_name')
    [ -n "$jupyter_payload" ] && [ "$jupyter_payload" != null ] || die "no jupyter-payload release in $packages_repo"
    step_set image jupyter_payload_release "\"$jupyter_payload\""
  fi
  if [ "$image_ref" != main ] && ! gh api "repos/$ports_repo/git/refs/heads/$image_ref" >/dev/null 2>&1; then
    # The branch carries main's workflow (and so its trust rules) at main's
    # head; the commit it builds is the ports_sha input, not the branch.
    ports_main=$(gh api "repos/$ports_repo/commits/main" --jq .sha)
    say "create $ports_repo $image_ref at main ($ports_main)"
    gh api -X POST "repos/$ports_repo/git/refs" -f "ref=refs/heads/$image_ref" -f "sha=$ports_main" >/dev/null
  fi
  dispatch_and_watch image "$ports_repo" release-playground-image.yml --ref "$image_ref" \
    -f "ports_sha=$ports_sha" -f "kernel_sha=$kernel_sha" \
    -f "yurt_cli_release=$smoke_cli_release" -f "yurt_cli_repo=$smoke_cli_repo" \
    -f "yurt_cli_sha256=$smoke_cli_sha256" \
    -f "jupyter_payload_release=$jupyter_payload" \
    -f "train=$train" -f "publish=$image_publish"
fi
# An image built off main publishes nothing: [3] tests the train's host and
# CLI against the image the page pins today.
native_image_release=$image_release
native_image_repo=$image_repo
if [ "$image_publish" = false ]; then
  native_image_release=$(jq -r .image.release "$root/artifacts/pins.json")
  native_image_repo=$(jq -r ".image.releaseRepo // \"$packages_repo\"" "$root/artifacts/pins.json")
  say "[3] tests against the pinned image $native_image_repo@$native_image_release"
fi
# [3] the desktop host and the CLI, one run
if [ "$(step_get native conclusion)" != success ]; then
  if [ "$native_ref" != main ] && ! gh api "repos/$sandbox_repo/git/refs/heads/$native_ref" >/dev/null 2>&1; then
    # The branch carries main's workflow at main's head; the commits it
    # builds are the sandbox_sha and kernel_sha inputs, not the branch.
    sandbox_main=$(gh api "repos/$sandbox_repo/commits/main" --jq .sha)
    say "create $sandbox_repo $native_ref at main ($sandbox_main)"
    gh api -X POST "repos/$sandbox_repo/git/refs" -f "ref=refs/heads/$native_ref" -f "sha=$sandbox_main" >/dev/null
  fi
  dispatch_and_watch native "$sandbox_repo" release-native.yml --ref "$native_ref" \
    -f "sandbox_sha=$sandbox_sha" -f "kernel_sha=$kernel_sha" \
    -f "kernel_wasm_release=$kernel_wasm_release" -f "kernel_wasm_repo=$kernel_wasm_repo" \
    -f "image_release=$native_image_release" -f "image_repo=$native_image_repo" \
    -f "train=$train" -f "publish=$native_publish"
fi

if [ "$validate" = 1 ]; then
  say "validated: every artifact of $train built and tested against the train's own artifacts"
  say "deleting the rehearsal's prereleases"
  for spec in "${rehearsal_releases[@]}"; do
    # With --image-release the train published no image or seal of its own.
    gh release view "${spec#*:}" --repo "${spec%%:*}" >/dev/null 2>&1 || continue
    gh release delete "${spec#*:}" --repo "${spec%%:*}" --yes --cleanup-tag \
      || die "could not delete ${spec%%:*} ${spec#*:}; delete the rest by hand (the next rehearsal refuses to start until then)"
  done
  if [ "$image_ref" != main ] && gh api "repos/$ports_repo/git/refs/heads/$image_ref" >/dev/null 2>&1; then
    gh api -X DELETE "repos/$ports_repo/git/refs/heads/$image_ref" \
      || die "could not delete $ports_repo's branch $image_ref; delete it by hand (the next rehearsal refuses to start until then)"
  fi
  if [ "$native_ref" != main ] && gh api "repos/$sandbox_repo/git/refs/heads/$native_ref" >/dev/null 2>&1; then
    gh api -X DELETE "repos/$sandbox_repo/git/refs/heads/$native_ref" \
      || die "could not delete $sandbox_repo's branch $native_ref; delete it by hand (the next rehearsal refuses to start until then)"
  fi
  rm -f "$state" # a finished rehearsal leaves nothing behind
  exit 0
fi
fi # pins_only

# [4] pins.json from the releases' own sidecars
sidecar_sha() {
  local repo=$1 tag=$2 asset=$3 dir
  dir=$(mktemp -d "${TMPDIR:-/tmp}/yurt-sidecar.XXXXXX")
  gh release download "$tag" --repo "$repo" --pattern "$asset.sha256" --dir "$dir" --clobber >/dev/null
  cut -d' ' -f1 "$dir/$asset.sha256"
  rm -rf "$dir"
}
say "generate artifacts/pins.json"
kernel_sha256=$(sidecar_sha "$kernel_wasm_repo" "$kernel_wasm_release" kernel-wasm.wasm)
image_sha256=$(sidecar_sha "$image_repo" "$image_release" playground-image.yurtimg)
image_rev_note=""
if [ "$build_image" = 0 ] && [ "$image_release" != "$(jq -r .image.release "$root/artifacts/pins.json")" ]; then
  image_rev_note=" (image release changed by hand; check the ports rev)"
fi
# The sealable CPython: the train's, from the image run's own sidecar; with
# a hand-cut image, the release named on the command line, or else the pin
# carried through unchanged (it must exist: the notebook kernel needs it).
if [ -n "$seal_release" ]; then
  python_seal_json=$(jq -n --arg ports "$ports_sha" --arg release "$seal_release" --arg repo "$seal_repo" \
    --arg sha "$(sidecar_sha "$seal_repo" "$seal_release" python3-seal.wasm)" \
    '{repo: "YurtOS/yurt-ports", rev: $ports, releaseRepo: $repo, release: $release, build: "ports/cpython/scripts/build-seal.sh", sha256: $sha}')
else
  python_seal_json=$(jq -c '.pythonSeal // empty' "$root/artifacts/pins.json")
  [ -n "$python_seal_json" ] || die "artifacts/pins.json has no pythonSeal entry to carry through; pass --python-seal-release"
fi
# The slim image the browser boots, published next to the full one by the
# image run; an older image release has none, and the browser then boots
# the full image as before.
slim_json='null'
image_assets=$(gh release view "$image_release" --repo "$image_repo" --json assets --jq '.assets[].name') ||
  die "cannot list the assets of $image_repo $image_release"
if grep -qx 'playground-slim.yurtimg' <<< "$image_assets"; then
  slim_json=$(jq -n --arg ports "$ports_sha" --arg release "$image_release" --arg repo "$image_repo" \
    --arg sha "$(sidecar_sha "$image_repo" "$image_release" playground-slim.yurtimg)" \
    '{repo: "YurtOS/yurt-ports", rev: $ports, releaseRepo: $repo, release: $release,
      build: "scripts/build-playground-image.sh", path: "ports/playground-image/build/dist/playground-slim.yurtimg", sha256: $sha}')
  # Its pages install the newest complete Python set from the live
  # repository (src/python_install.ts): one must exist before a train pins
  # the slim image, or every Python page would fail.
  common=""
  # python-seal too: the set's Suspend/Resume interpreter.
  for name in python numpy pyzmq jupyter-kernel python-seal; do
    builds=$(curl -fsSL --retry 3 "https://raw.githubusercontent.com/YurtOS/yurt-packages/main/packages/$name.json" |
      jq -r '.versions[] | select((.yanked | not) and (.build | test("^yurt_[0-9]+$"))) | .build' | sort -u) ||
      die "yurt-packages has no $name package: publish the Python set before pinning the slim image"
    if [ "$name" = python ]; then common=$builds; else common=$(comm -12 <(echo "$common") <(echo "$builds")); fi
  done
  [ -n "$common" ] || die "yurt-packages has no complete Python set (python, numpy, pyzmq, jupyter-kernel, python-seal with one yurt_N build)"
  say "slim image: the newest Python set complete with its seal is $(sort -t_ -k2 -n <<< "$common" | tail -1)"
fi
host_json='{}'
cli_json='{}'
# The CLI's package names carry its version; the release's asset list says
# which, so the generator never guesses it.
cli_assets=$(gh release view "$cli_release" --repo "$cli_repo" --json assets --jq '.assets[].name')
cli_asset_for() {
  case $1 in
    x86_64-unknown-linux-gnu) grep -E '^yurt_.*_amd64\.deb$' <<< "$cli_assets" ;;
    aarch64-unknown-linux-gnu) grep -E '^yurt_.*_arm64\.deb$' <<< "$cli_assets" ;;
    *) grep -F "yurt-$1.tar.gz" <<< "$cli_assets" | grep -v '\.sha256$' ;;
  esac
}
for target in aarch64-apple-darwin x86_64-unknown-linux-gnu aarch64-unknown-linux-gnu; do
  host_json=$(jq --arg t "$target" --arg s "$(sidecar_sha "$host_repo" "$host_release" "yurt-desktop-host-$target.tar.gz")" '. + {($t): $s}' <<< "$host_json")
  asset=$(cli_asset_for "$target" | head -1)
  [ -n "$asset" ] || die "$cli_release has no package for $target"
  cli_json=$(jq --arg t "$target" --arg a "$asset" --arg s "$(sidecar_sha "$cli_repo" "$cli_release" "$asset")" \
    '. + {($t): {asset: $a, sha256: $s}}' <<< "$cli_json")
done
# The sealed sandbox snapshot (scripts/release-snapshot.ts) is captured by
# hand, not by the train: the old entry goes into the new pins, and stays
# only if release-snapshot.ts --check-pin says it is this train's (well
# formed, this page's format, built from these pins, of the Python set the
# live index offers); otherwise it is dropped (scripts/lib/snapshot-pin.sh).
snapshot_json=$(jq -c '.snapshot // null' "$root/artifacts/pins.json")
# `repo`/`rev` say where the source is; `releaseRepo`/`release` where the
# bytes are (a train's in the repository that built them, a hand-cut one in
# yurt-packages). Every consumer fetches through releaseRepo.
jq -n --arg train "$train" --arg kernel_sha "$kernel_sha" --arg sandbox_sha "$sandbox_sha" \
  --arg kernel_release "$kernel_wasm_release" --arg kernel_repo "$kernel_wasm_repo" --arg kernel_sha256 "$kernel_sha256" \
  --arg image_release "$image_release" --arg image_repo "$image_repo" --arg image_sha256 "$image_sha256" --arg ports_sha "$ports_sha" \
  --arg host_release "$host_release" --arg host_repo "$host_repo" --arg cli_release "$cli_release" --arg cli_repo "$cli_repo" \
  --argjson host "$host_json" --argjson cli "$cli_json" --argjson python_seal "$python_seal_json" \
  --argjson slim "$slim_json" --argjson snapshot "$snapshot_json" '{
    train: $train,
    kernelWasm: {repo: "YurtOS/yurtos-kernel", rev: $kernel_sha, releaseRepo: $kernel_repo, release: $kernel_release,
      build: "scripts/build-kernel-wasm.sh", path: "target/kernel-wasm/release/yurt_kernel.wasm", sha256: $kernel_sha256},
    image: {repo: "YurtOS/yurt-ports", rev: $ports_sha, releaseRepo: $image_repo, release: $image_release,
      build: "scripts/build-playground-image.sh", path: "ports/playground-image/build/dist/playground.yurtimg", sha256: $image_sha256},
    desktopHost: {repo: "YurtOS/yurt-sandbox", rev: $sandbox_sha, releaseRepo: $host_repo, release: $host_release,
      build: "scripts/build-desktop-host.sh", sha256: $host},
    yurtCli: {repo: "YurtOS/yurt-sandbox", rev: $sandbox_sha, releaseRepo: $cli_repo, release: $cli_release,
      build: "scripts/build-yurt-cli.sh",
      assets: ($cli | with_entries(.value = .value.asset)),
      sha256: ($cli | with_entries(.value = .value.sha256))},
    pythonSeal: $python_seal
  } + (if $slim == null then {} else {browserImage: $slim} end)
    + (if $snapshot == null then {} else {snapshot: $snapshot} end)' > "$root/artifacts/pins.json"
keep_snapshot_pin "$root" || die "$snapshot_error; fix that and $(resume_command)"
if [ "${snapshot_dropped:-0}" = 1 ]; then
  say "the pinned snapshot is not this train's ($snapshot_why): dropped"
  # Kept with the train, so a --resume still ends with the reminder below.
  [ "$pins_only" = 1 ] || step_set snapshot dropped "$(jq -n --arg why "$snapshot_why" '$why')"
fi
say "verify the pins: scripts/install-pinned-artifacts.sh"
"$root/scripts/install-pinned-artifacts.sh"
if [ "$pins_only" = 1 ]; then
  [ "${snapshot_dropped:-0}" = 1 ] && say "the snapshot pin was dropped ($snapshot_why): run scripts/release-snapshot.ts (deno run -A)"
  say "pins regenerated and verified; nothing dispatched, nothing opened"
  exit 0
fi

# [4] the pin PR, merged on a yes -- on a checkout with nothing else in it.
# A --resume finds the PR an earlier run opened (or merged) for this train
# and carries on from there rather than committing the pins again.
branch="release/$train"
existing=$(gh pr list --repo YurtOS/yurt-playground --head "$branch" --state all \
  --json url,state --jq 'map(select(.state != "CLOSED")) | .[0] // empty')
pr_url=$(jq -r .url <<<"$existing" 2>/dev/null || true)
pr_state=$(jq -r .state <<<"$existing" 2>/dev/null || true)
if [ -n "$pr_url" ]; then
  say "pin PR: $pr_url ($pr_state)"
  # A merged PR's branch is gone (the merge below deletes it), so its pins
  # are read from the merge commit.
  pins_ref=$branch
  if [ "$pr_state" = MERGED ]; then
    pins_ref=$(gh pr view "$pr_url" --repo YurtOS/yurt-playground --json mergeCommit --jq .mergeCommit.oid)
  fi
  seal_release_of_train=$(git -C "$root" fetch -q origin "$pins_ref" 2>/dev/null \
    && git -C "$root" show FETCH_HEAD:artifacts/pins.json | jq -r .pythonSeal.release) \
    || die "cannot read artifacts/pins.json of $pr_url at $pins_ref"
else
  [ -z "$(git -C "$root" status --porcelain --untracked-files=no | grep -v ' artifacts/pins.json$')" ] \
    || die "the playground checkout has uncommitted changes; commit or stash them first"
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
  pr_state=OPEN
  seal_release_of_train=$(jq -r .pythonSeal.release "$root/artifacts/pins.json")
  say "pin PR: $pr_url"
fi
if [ "$pr_state" != MERGED ]; then
  read -r -p "merge $pr_url and deploy? [y/N] " answer
  case $answer in
    y|Y|yes) ;;
    *) say "left open: $pr_url"; exit 0 ;;
  esac
  # The merge needs the PR's required checks; watch them first (a failure
  # here is the page's CI against the new pins, fix and --resume).
  say "waiting for the checks on $pr_url"
  gh pr checks "$pr_url" --repo YurtOS/yurt-playground --watch --fail-fast >/dev/null \
    || die "checks failed on $pr_url; fix them, then $(resume_command)"
  gh pr merge "$pr_url" --repo YurtOS/yurt-playground --squash --delete-branch
fi
say "deploy: gh run list --repo YurtOS/yurt-playground --workflow deploy-pages.yml"

# [5] the desktop installers, from the merge commit: the app for the three
# targets with the train's CLI packages beside it, released as
# desktop-<train> (what the home page's download links resolve to).
merge_sha=$(gh pr view "$pr_url" --json mergeCommit --jq .mergeCommit.oid)
[ -n "$merge_sha" ] && [ "$merge_sha" != null ] || die "could not read the merge commit of $pr_url"
if [ "$(step_get desktop conclusion)" != success ]; then
  dispatch_and_watch desktop YurtOS/yurt-playground release-desktop.yml \
    -f "playground_sha=$merge_sha" -f "train=$train" -f "publish=true"
fi
say "released: kernel-wasm-$train, $image_release, $seal_release_of_train, desktop-host-$train, yurt-cli-$train, desktop-$train"
snapshot_dropped_why=$(step_get snapshot dropped)
if [ -n "$snapshot_dropped_why" ]; then
  say "the snapshot pin was dropped ($snapshot_dropped_why): run scripts/release-snapshot.ts (deno run -A), then commit artifacts/pins.json"
fi
