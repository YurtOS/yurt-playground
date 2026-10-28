# shellcheck shell=bash
# snapshot-pin.sh -- sourced by release-playground.sh.
#
# keep_snapshot_pin ROOT: ROOT/artifacts/pins.json keeps its `snapshot`
# entry only if `scripts/release-snapshot.ts --check-pin` accepts it (well
# formed, this page's format, built from these pins, of the Python set the
# live index offers: the checks the page makes). Otherwise the entry is
# removed, snapshot_dropped=1 and snapshot_why says why.
keep_snapshot_pin() {
  local root=$1 pins=$1/artifacts/pins.json out
  [ "$(jq -c '.snapshot // null' "$pins")" != null ] || return 0
  if out=$(cd "$root" && deno run -A scripts/release-snapshot.ts --check-pin 2>&1); then
    return 0
  fi
  jq 'del(.snapshot)' "$pins" > "$pins.tmp" && mv "$pins.tmp" "$pins"
  snapshot_why=$(tail -1 <<< "$out")
  snapshot_why=${snapshot_why#release-snapshot: }
  snapshot_dropped=1
}
