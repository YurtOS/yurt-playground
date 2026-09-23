#!/usr/bin/env bash
# fetch-llm.sh — the local agent's model weights (#140), into artifacts/llm/:
# web-compatible Gemma models from Hugging Face, by commit, each checked
# against its pinned sha256 before it is moved into place. The pins are
# src/llm_models.ts's (tests/llm_models_test.ts keeps the two in step).
#
#   scripts/fetch-llm.sh            # E4B, the agent's default
#   scripts/fetch-llm.sh E2B E4B
#
# `deno task serve` serves them from the page's own origin (/llm/…): the
# playground CSP is `connect-src 'self'`. The runtime's wasm needs no fetch;
# it is served from node_modules/@litert-lm/core, pinned by deno.lock.
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
dest=$root/artifacts/llm

model_pin() {
  case $1 in
  E4B) echo "2eee7ac325f20eb8c9ac1d0e972f7c84663062da 3904d826d5dddd25ea173e85204caec09e68ba038116e9b992b69cbdc94f57a0" ;;
  E2B) echo "b3ca0d2f076785a8f4b2219ddbd2bdb99954eae1 3a08e8d94e23b814ae5414469c370c503813949acb8ceaa17e4ebf8a35af35b5" ;;
  *)
    echo "fetch-llm: unknown model $1 (E2B or E4B)" >&2
    exit 1
    ;;
  esac
}

mkdir -p "$dest"
for name in "${@:-E4B}"; do
  pin=$(model_pin "$name")
  read -r commit sha256 <<<"$pin"
  file=gemma-4-$name-it-web.litertlm
  out=$dest/$file
  if [[ -f "$out" ]] && [[ $(shasum -a 256 "$out" | cut -d' ' -f1) == "$sha256" ]]; then
    echo "have $file" >&2
    continue
  fi
  url=https://huggingface.co/litert-community/gemma-4-$name-it-litert-lm/resolve/$commit/$file
  echo "fetching $url" >&2
  curl -sSfL --retry 3 -o "$out.part" "$url"
  actual=$(shasum -a 256 "$out.part" | cut -d' ' -f1)
  if [[ "$actual" != "$sha256" ]]; then
    rm -f "$out.part"
    echo "$file: sha256 $actual, pinned $sha256" >&2
    exit 1
  fi
  mv "$out.part" "$out"
done
ls -l "$dest" >&2
