#!/usr/bin/env bash
# fetch-llm-spike.sh — the #140 feasibility spike's blobs, into artifacts/llm/:
# the LiteRT-LM web runtime's wasm (from its npm tarball) and one or more
# web-compatible Gemma models (from Hugging Face, by commit). Every download is
# checked against the sha256 pinned below before it is moved into place.
#
#   scripts/fetch-llm-spike.sh            # runtime + E2B
#   scripts/fetch-llm-spike.sh E2B E4B    # runtime + both models
#
# The page serves them from its own origin (/llm/…): the playground CSP is
# `connect-src 'self'`, so it can load nothing from Hugging Face directly.
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
dest=$root/artifacts/llm

LITERT_VERSION=0.17.1
LITERT_SHA256=047398e89a656a2762dbbd670905a43c1095ef0919bb08816b47770e1ad75448

model_pin() {
  case $1 in
  E2B) echo "b3ca0d2f076785a8f4b2219ddbd2bdb99954eae1 3a08e8d94e23b814ae5414469c370c503813949acb8ceaa17e4ebf8a35af35b5" ;;
  E4B) echo "2eee7ac325f20eb8c9ac1d0e972f7c84663062da 3904d826d5dddd25ea173e85204caec09e68ba038116e9b992b69cbdc94f57a0" ;;
  *)
    echo "fetch-llm-spike: unknown model $1 (E2B or E4B)" >&2
    exit 1
    ;;
  esac
}

# Download $1 to $2, verify sha256 $3, then move into place.
fetch() {
  local url=$1 out=$2 expected=$3 actual
  if [[ -f "$out" ]] && [[ $(shasum -a 256 "$out" | cut -d' ' -f1) == "$expected" ]]; then
    echo "have $(basename "$out")" >&2
    return
  fi
  echo "fetching $url" >&2
  curl -sSfL --retry 3 -o "$out.part" "$url"
  actual=$(shasum -a 256 "$out.part" | cut -d' ' -f1)
  if [[ "$actual" != "$expected" ]]; then
    rm -f "$out.part"
    echo "$(basename "$out"): sha256 $actual, pinned $expected" >&2
    exit 1
  fi
  mv "$out.part" "$out"
}

mkdir -p "$dest/wasm"
tarball=$dest/litert-lm-core-$LITERT_VERSION.tgz
fetch "https://registry.npmjs.org/@litert-lm/core/-/core-$LITERT_VERSION.tgz" \
  "$tarball" "$LITERT_SHA256"
tar -xzf "$tarball" -C "$dest/wasm" --strip-components=2 package/wasm

for name in "${@:-E2B}"; do
  read -r commit sha256 <<<"$(model_pin "$name")"
  file=gemma-4-$name-it-web.litertlm
  fetch "https://huggingface.co/litert-community/gemma-4-$name-it-litert-lm/resolve/$commit/$file" \
    "$dest/$file" "$sha256"
done
ls -l "$dest" "$dest/wasm" >&2
