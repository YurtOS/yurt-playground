#!/usr/bin/env bash
# build-python-seal.sh — the sealable CPython the suspend/resume notebook
# kernel runs (public/demo/python3-seal.wasm).
#
# The playground image's python3 cannot be sealed: yurt-cc instruments only
# the fork family with Asyncify, and a sandbox seal has to unwind the guest at
# `yurt.syscall` — from wherever it is when the seal lands (mid-print, parked
# in a read). So the interpreter is relinked from the cpython port's build
# tree with a marker export (`yurt_asyncify_syscall`, which is how a host
# tells a sealable guest from a stock one), the link before yurt-cc's own
# wasm-opt is kept, and wasm-opt is rerun over it with the wide import list.
#
# `-O2` after `--asyncify` is not optional: Asyncify flattens every
# instrumented function, and unoptimised that leaves CPython's evaluation
# loop with thousands of locals. On V8's baseline tier each local is a stack
# slot, and the interpreter then needs ~2 MB of native stack to start —
# twice what a Worker gets in Chrome. Optimised, it starts in 600 KB.
#
# Needs: the cpython port built (yurt-ports/ports/cpython, `make` done in
# build/source/Python-*/) and the guest SDK's environment sourced
# (`source yurtos-kernel/target/yurt-sdk/env.sh`: yurt-cc, its sysroot and
# wasm-opt). Takes about a minute: the relink, then wasm-opt.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
out=${1:-"$here/../public/demo/python3-seal.wasm"}
ports=${YURT_PORTS_ROOT:-"$here/../../yurt-ports"}
: "${YURT_CC:?source yurtos-kernel/target/yurt-sdk/env.sh first}"
: "${YURT_TOOLCHAIN_ROOT:?source yurtos-kernel/target/yurt-sdk/env.sh first}"
yurt_cc=$YURT_CC
wasm_opt=$YURT_TOOLCHAIN_ROOT/bin/wasm-opt

source_dir=$(ls -d "$ports"/ports/cpython/build/source/Python-*/ | head -1)
[[ -f "$source_dir/Programs/python.o" ]] ||
  { echo "cpython port not built at $source_dir" >&2; exit 1; }

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# The marker: a data export, so nothing about the program changes.
cat > "$tmp/marker.c" <<'EOF'
const int yurt_asyncify_syscall __attribute__((used, visibility("default"))) = 1;
EOF
"$yurt_cc" -c "$tmp/marker.c" -o "$tmp/marker.o"

# The port's own link line (`make -n python.exe`), with the marker object
# and the pre-opt link preserved. The output must end in .wasm for yurt-cc
# to keep the pre-opt file.
link=$(cd "$source_dir" && make -n python.exe | grep -- '-o python.exe' | tail -1)
[[ -n "$link" ]] || { echo "could not recover the python.exe link line" >&2; exit 1; }
link=${link//-o python.exe/-o "$tmp/python.wasm" "$tmp/marker.o"}
(
  cd "$source_dir"
  YURT_CC_PRESERVE_PRE_OPT="$tmp/preopt.wasm" bash -c "$link"
)
[[ -f "$tmp/preopt.wasm" ]] || { echo "yurt-cc did not preserve the pre-opt link" >&2; exit 1; }

"$wasm_opt" \
  --enable-sign-ext --enable-nontrapping-float-to-int --enable-threads \
  --enable-exception-handling --enable-reference-types \
  --asyncify \
  '--pass-arg=asyncify-imports@yurt.syscall,yurt.syscall_fork_family,yurt.host_setjmp,yurt.host_longjmp' \
  --translate-to-exnref \
  -O2 \
  "$tmp/preopt.wasm" -o "$out"
echo "wrote $out ($(wc -c < "$out") bytes)"
