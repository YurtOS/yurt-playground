#!/usr/bin/env bash
# build-desktop.sh — compile the built site (dist/) plus a local
# isolation-header server into a desktop bundle for one target, and package
# it for release.
#
# The binary is the local server; the site travels beside it (deno compile
# cannot embed the kernel wasm: its --include parser rejects a module V8
# validates). Run the bundle and the playground opens in the default
# browser.
#
#   macOS   "Yurt Playground.app" with dist/ in Contents/Resources, zipped.
#           Not signed or notarized, so Gatekeeper asks on first open
#           (right-click → Open).
#   Linux   yurt-playground/ with the binary and dist/ side by side, as a
#           tarball; run ./yurt-playground from a terminal.
#
# Usage: scripts/build-desktop.sh [--target <target>]
#   Targets: aarch64-apple-darwin x86_64-apple-darwin
#            x86_64-unknown-linux-gnu aarch64-unknown-linux-gnu
#   Output: dist-desktop/<target>/ (the bundle) and
#           dist-desktop/Yurt-Playground-<target>.{zip,tar.gz}
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
  aarch64-apple-darwin | x86_64-apple-darwin) family=macos ;;
  x86_64-unknown-linux-gnu | aarch64-unknown-linux-gnu) family=linux ;;
  *) echo "build-desktop: $target is not a macOS or Linux target" >&2; exit 2 ;;
esac
cd "$root"
test -f dist/index.html || {
  echo "build-desktop: no dist/index.html; run: deno task build-static" >&2
  exit 1
}
out=dist-desktop/$target
rm -rf "$out" "dist-desktop/Yurt-Playground-$target".*
mkdir -p "$out"

# Linux: the binary and dist/ side by side in a directory the tarball
# unpacks to. macOS: the bare binary, then the .app around it.
if [ "$family" = linux ]; then
  binary="$out/yurt-playground/yurt-playground"
else
  binary="$out/yurt-playground"
fi
# Permissions are fixed at compile time: reading the site, the loopback
# listener, and the platform's opener for the browser. Nothing else.
deno compile \
  --target "$target" \
  --allow-read --allow-net=127.0.0.1 --allow-run=open,xdg-open \
  --output "$binary" \
  scripts/desktop.ts

if [ "$family" = linux ]; then
  cp -R dist "$out/yurt-playground/dist"
  tar -czf "dist-desktop/Yurt-Playground-$target.tar.gz" -C "$out" yurt-playground
  echo "built $out/yurt-playground/ and dist-desktop/Yurt-Playground-$target.tar.gz"
  exit 0
fi

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
# ditto keeps the bundle's structure and executable bits; on a Linux host,
# zip does the same for what matters.
if command -v ditto >/dev/null; then
  (cd "$out" && ditto -c -k --keepParent "Yurt Playground.app" "../Yurt-Playground-$target.zip")
else
  (cd "$out" && zip -qr "../Yurt-Playground-$target.zip" "Yurt Playground.app")
fi
echo "built \"$app\" and dist-desktop/Yurt-Playground-$target.zip"
