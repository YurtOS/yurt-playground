#!/usr/bin/env bash
# build-desktop.sh — compile the built site (dist/) plus a local
# isolation-header server into one macOS executable, and wrap it as a
# double-clickable .app.
#
# The binary is the local server; the site travels beside it as the .app's
# Contents/Resources/dist (deno compile cannot embed the kernel wasm: its
# --include parser rejects a module V8 validates). Open the .app and the
# playground opens in the default browser. It is not signed or notarized, so
# Gatekeeper asks on first open (right-click → Open).
#
# Usage: scripts/build-desktop.sh [--target aarch64-apple-darwin|x86_64-apple-darwin]
#   Output: dist-desktop/<target>/"Yurt Playground.app" (and the bare
#   yurt-playground binary, which serves a dist/ found beside the repository).
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
target=$(deno eval 'console.log(Deno.build.target)')
while [ $# -gt 0 ]; do
  case $1 in
    --target) target=$2; shift 2 ;;
    *) echo "build-desktop: unknown argument $1" >&2; exit 2 ;;
  esac
done
case $target in
  aarch64-apple-darwin | x86_64-apple-darwin) ;;
  *) echo "build-desktop: $target is not a macOS target" >&2; exit 2 ;;
esac
cd "$root"
test -f dist/index.html || {
  echo "build-desktop: no dist/index.html; run: deno task build-static" >&2
  exit 1
}
out=dist-desktop/$target
rm -rf "$out"
mkdir -p "$out"

# Permissions are fixed at compile time: reading the site, the loopback
# listener, and `open` for the browser. Nothing else.
deno compile \
  --target "$target" \
  --allow-read --allow-net=127.0.0.1 --allow-run=open \
  --output "$out/yurt-playground" \
  scripts/desktop.ts

app="$out/Yurt Playground.app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp "$out/yurt-playground" "$app/Contents/MacOS/yurt-playground"
cp -R dist "$app/Contents/Resources/dist"
# Finder launches a bundle without a terminal; the launcher opens one so the
# server has a window whose closing stops it.
cat > "$app/Contents/MacOS/Yurt Playground" <<'LAUNCH'
#!/bin/bash
exec open -a Terminal "$(dirname "$0")/yurt-playground"
LAUNCH
chmod +x "$app/Contents/MacOS/Yurt Playground"
cat > "$app/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Yurt Playground</string>
  <key>CFBundleDisplayName</key><string>Yurt Playground</string>
  <key>CFBundleIdentifier</key><string>org.yurtos.playground</string>
  <key>CFBundleVersion</key><string>0.1.0</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>Yurt Playground</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
</dict>
</plist>
PLIST
echo "built $out/yurt-playground and \"$app\""
