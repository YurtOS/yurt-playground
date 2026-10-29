# shellcheck shell=bash
# snapshot-pin.sh -- sourced by release-playground.sh.
#
# keep_snapshot_pin ROOT [KEY KIND]: ROOT/artifacts/pins.json keeps its KEY
# entry (default `snapshot`, the desktop's; `tabletSnapshot` tablet,
# `phoneSnapshot` phone: src/sandbox_snapshot.ts SNAPSHOT_KINDS) unless
# `scripts/release-snapshot.ts --check-pin --kind KIND` refuses it (exit 3,
# with a "snapshot pin refused: <reason>" line): well formed, this page's
# format, built from these pins, of the Python set the live index offers --
# the checks the page makes. A kept entry sets snapshot_kept=1. A refused
# entry is removed, then
# snapshot_dropped=1 and snapshot_why says why. Any other outcome (deno
# missing, a crash, exit 1) and a failed removal return 1 with
# snapshot_error saying which (the check's whole output goes to stderr),
# the pin untouched: a check that did not run is no verdict.
keep_snapshot_pin() {
  local root=$1 key=${2:-snapshot} kind=${3:-desktop} pins=$1/artifacts/pins.json out code=0 why err
  [ "$(jq -c --arg k "$key" '.[$k] // null' "$pins")" != null ] || return 0
  local by_kind=()
  [ "$kind" = desktop ] || by_kind=(--kind "$kind")
  out=$(cd "$root" && deno run -A scripts/release-snapshot.ts --check-pin ${by_kind[@]+"${by_kind[@]}"} 2>&1) || code=$?
  case $code in
    0)
      snapshot_kept=1
      return 0
      ;;
    3) ;;
    *)
      # All of it on stderr; the line naming the error in the message (an
      # uncaught exception ends in stack frames, not in its name).
      printf '%s\n' "$out" >&2
      # One awk over all of it: no pipe to break early, colours stripped,
      # the first "error:" line or else the last line.
      local named
      named=$(awk '{ gsub(/\033\[[0-9;]*m/, "") }
        !found && /error:/ { first = $0; found = 1 }
        { last = $0 }
        END { print found ? first : last }' <<< "$out")
      snapshot_error="release-snapshot.ts --check-pin failed (exit $code): $named"
      return 1
      ;;
  esac
  why=$(sed -n 's/^snapshot pin refused: //p' <<< "$out" | tail -1)
  if ! err=$( { jq --arg k "$key" 'del(.[$k])' "$pins" > "$pins.tmp" && mv "$pins.tmp" "$pins"; } 2>&1); then
    rm -f "$pins.tmp"
    snapshot_error="the $key entry was refused (${why:-no reason given}) but could not be removed from $pins: $err"
    return 1
  fi
  snapshot_why=${why:-no reason given}
  snapshot_dropped=1
}

# remind_dropped_snapshot WHY: the closing reminder for a train that
# dropped its snapshot pin (WHY empty: none).
remind_dropped_snapshot() {
  [ -n "$1" ] || return 0
  say "the snapshot pin was dropped ($1): run scripts/release-snapshot.ts (deno run -A; --kind tablet or phone for those pins), then commit artifacts/pins.json"
}
