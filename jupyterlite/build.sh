#!/usr/bin/env bash
# build.sh — build the JupyterLite site with the Yurt kernel into public/jupyter.
#
# JupyterLite supplies the JupyterLab/Notebook frontend and a browser-side
# Jupyter Server API; the only kernel is yurt-kernel/, a labextension that
# relays every message to the real ipykernel in the sandbox through
# /playground-bridge.js (see src/lite_bridge.ts). No kernel runs in the
# browser.
#
# Needs python3 (3.10+) and node/npm. The Python deps go into a venv under
# jupyterlite/.venv unless JUPYTERLITE_PYTHON names an interpreter that already
# has jupyterlite/requirements.txt installed (CI does that).
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
out=${1:-"$here/../public/jupyter"}

python=${JUPYTERLITE_PYTHON:-}
if [[ -z "$python" ]]; then
  if [[ ! -x "$here/.venv/bin/python" ]]; then
    python3 -m venv "$here/.venv"
    "$here/.venv/bin/pip" install -q --disable-pip-version-check -r "$here/requirements.txt"
  fi
  python="$here/.venv/bin/python"
fi
bin=$(dirname "$python")

# 1. The kernel labextension (webpack federated module).
(
  cd "$here/yurt-kernel"
  if [[ ! -d node_modules ]]; then npm ci --no-audit --no-fund; fi
  PATH="$bin:$PATH" npm run build
)
rm -rf "$here/ext"
mkdir -p "$here/ext/@yurt"
cp -R "$here/yurt-kernel/yurt_jupyterlite_kernel/labextension" "$here/ext/@yurt/jupyterlite-yurt-kernel"

# 2. The site. The doit database goes with the output: left behind, it marks
# the config patch up to date and the rebuilt site ships without our config.
rm -rf "$out" "$here"/.jupyterlite.doit.db*
(
  cd "$here"
  "$bin/jupyter" lite build --output-dir "$out"
)
# The disabled extensions keep guest-controlled output from running script or
# fetching URLs in the page; a site without them must not ship.
"$python" - "$here/jupyter-lite.json" "$out/jupyter-lite.json" <<'EOF'
import json, sys
want, got = (json.load(open(p))["jupyter-config-data"].get("disabledExtensions", []) for p in sys.argv[1:])
missing = set(want) - set(got)
if missing:
    sys.exit(f"{sys.argv[2]} lacks disabledExtensions {sorted(missing)}")
EOF
echo "built JupyterLite site at $out"
