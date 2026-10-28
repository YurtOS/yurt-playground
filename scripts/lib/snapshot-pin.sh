# shellcheck shell=bash
# snapshot-pin.sh -- sourced by release-playground.sh.
#
# keep_snapshot_pin ROOT: ROOT/artifacts/pins.json keeps its `snapshot`
# entry unless `scripts/release-snapshot.ts --check-pin` refuses it (exit 3,
# with a "snapshot pin refused: <reason>" line): well formed, this page's
# format, built from these pins, of the Python set the live index offers --
# the checks the page makes. A refused entry is removed, then
# snapshot_dropped=1 and snapshot_why says why. Any other outcome (deno
# missing, a crash, exit 1) and a failed removal return 1 with
# snapshot_error saying which, the pin untouched: a check that did not run
# is no verdict.
keep_snapshot_pin() {
  local root=$1 pins=$1/artifacts/pins.json out code=0 why err
  [ "$(jq -c '.snapshot // null' "$pins")" != null ] || return 0
  out=$(cd "$root" && deno run -A scripts/release-snapshot.ts --check-pin 2>&1) || code=$?
  case $code in
    0) return 0 ;;
    3) ;;
    *)
      snapshot_error="release-snapshot.ts --check-pin failed (exit $code): $(tail -5 <<< "$out")"
      return 1
      ;;
  esac
  why=$(sed -n 's/^snapshot pin refused: //p' <<< "$out" | tail -1)
  if ! err=$( { jq 'del(.snapshot)' "$pins" > "$pins.tmp" && mv "$pins.tmp" "$pins"; } 2>&1); then
    rm -f "$pins.tmp"
    snapshot_error="the snapshot entry was refused (${why:-no reason given}) but could not be removed from $pins: $err"
    return 1
  fi
  snapshot_why=${why:-no reason given}
  snapshot_dropped=1
}
