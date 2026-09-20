#!/usr/bin/env bash
# build-python-seal.sh — the sealable CPython the suspend/resume notebook
# kernel runs (public/demo/python3-seal.wasm), for a local build of the
# blob the `pythonSeal` pin otherwise installs.
#
# The builder lives with the build tree it relinks:
# yurt-ports/ports/cpython/scripts/build-seal.sh (why the interpreter is
# relinked with Asyncify, why -O2 after --asyncify is mandatory). The
# release train builds it there, from the same cpython build the image
# stages, and publishes it as python-seal-<train> beside the image
# (yurt-playground#78, part A2).
#
# Needs: the cpython port built in the yurt-ports checkout and the guest
# SDK's environment sourced (`source yurtos-kernel/target/yurt-sdk/env.sh`).
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
out=${1:-"$here/../public/demo/python3-seal.wasm"}
ports=${YURT_PORTS_ROOT:-"$here/../../yurt-ports"}
builder=$ports/ports/cpython/scripts/build-seal.sh
[[ -x "$builder" ]] || { echo "build-python-seal: no $builder (a yurt-ports checkout with ports/cpython/scripts/build-seal.sh; set YURT_PORTS_ROOT)" >&2; exit 1; }
exec "$builder" "$out"
