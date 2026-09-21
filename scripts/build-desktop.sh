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
#   macOS   "Yurt Playground.app" with dist/ and runtime/ in
#           Contents/Resources, on a .dmg with an Applications shortcut. Not
#           signed or notarized, so Gatekeeper blocks the first open until
#           allowed in System Settings → Privacy & Security.
#   Linux   a .deb installing /usr/lib/yurt-playground/ (the binary, dist/
#           and runtime/ side by side), /usr/bin/yurt-playground and a
#           desktop entry; it depends on the glibc runtime/GLIBC_REQUIRED
#           names when the desktop-host release records one.
#
# The bundled dist/ omits the kernel wasm and image parts: the page never
# fetches them in native mode, and runtime/ carries both.
#
# Usage: scripts/build-desktop.sh [--target <target>]
#   Targets: aarch64-apple-darwin (Apple Silicon only: nothing ships for
#            Intel macOS) x86_64-unknown-linux-gnu aarch64-unknown-linux-gnu
#   Output: dist-desktop/<target>/ (the staged bundle, what the acceptance
#           runs) and dist-desktop/Yurt-Playground-<target>.{dmg,deb}
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
# One version for the .app, the .deb and the page; bump here.
version=0.1.0
target=$(deno eval 'console.log(Deno.build.target)')
while [ $# -gt 0 ]; do
  case $1 in
    --target) target=$2; shift 2 ;;
    *) echo "build-desktop: unknown argument $1" >&2; exit 2 ;;
  esac
done
case $target in
  aarch64-apple-darwin) family=macos ;;
  x86_64-apple-darwin) echo "build-desktop: Intel macOS is no longer a target (yurt-playground#121); build on or for Apple Silicon" >&2; exit 2 ;;
  x86_64-unknown-linux-gnu) family=linux; deb_arch=amd64 ;;
  aarch64-unknown-linux-gnu) family=linux; deb_arch=arm64 ;;
  *) echo "build-desktop: $target is not a macOS or Linux target" >&2; exit 2 ;;
esac
cd "$root"
test -f dist/index.html || {
  echo "build-desktop: no dist/index.html; run: deno task build-static" >&2
  exit 1
}
runtime=runtime/$target
for file in yurt-desktop-host yurt-runtime-wasmtime yurt_kernel.wasm playground.yurtimg; do
  test -f "$runtime/$file" || {
    echo "build-desktop: no $runtime/$file; run: scripts/install-desktop-host.sh --target $target" >&2
    exit 1
  }
done
out=dist-desktop/$target
rm -rf "$out" "dist-desktop/Yurt-Playground-$target".*
mkdir -p "$out"

# The site without the in-tab blobs, and the runtime beside it.
site=$out/site
mkdir -p "$site/dist"
cp -R dist/. "$site/dist/"
rm -f "$site/dist/yurt_kernel.wasm" "$site/dist"/playground.yurtimg.*
cp -R "$runtime" "$site/runtime"

# Linux: the binary and dist/ side by side in a directory the tarball
# unpacks to. macOS: the bare binary, then the .app around it.
if [ "$family" = linux ]; then
  binary="$out/yurt-playground/yurt-playground"
else
  binary="$out/yurt-playground"
fi
# Permissions are fixed at compile time: reading the bundle, the loopback
# listener, running the host beside it and the platform's browser opener,
# and writing the API token to ~/.yurt/playground.json (the home is not
# known here, so the write is not narrowed; the launcher writes that one
# file). Nothing else.
deno compile \
  --target "$target" \
  --allow-read --allow-write --allow-env=HOME,USERPROFILE \
  --allow-net=127.0.0.1 --allow-run \
  --output "$binary" \
  scripts/desktop.ts

if [ "$family" = linux ]; then
  cp -R "$site/dist" "$out/yurt-playground/dist"
  cp -R "$site/runtime" "$out/yurt-playground/runtime"
  rm -rf "$site"
  # A .deb is ar(debian-binary, control.tar.gz, data.tar.gz), built here with
  # tar and ar so it needs no dpkg on the building machine; CI's Linux job
  # checks it with dpkg-deb and installs it.
  pkg=$out/deb
  rm -rf "$pkg"
  mkdir -p "$pkg/data/usr/lib" "$pkg/data/usr/bin" "$pkg/data/usr/share/applications" "$pkg/control"
  cp -R "$out/yurt-playground" "$pkg/data/usr/lib/yurt-playground"
  cat > "$pkg/data/usr/bin/yurt-playground" <<'WRAP'
#!/bin/sh
exec /usr/lib/yurt-playground/yurt-playground "$@"
WRAP
  chmod 0755 "$pkg/data/usr/bin/yurt-playground"
  cat > "$pkg/data/usr/share/applications/yurt-playground.desktop" <<'DESKTOP'
[Desktop Entry]
Type=Application
Name=Yurt Playground
Comment=A Linux sandbox with Python and Jupyter, running natively, shown in your browser
Exec=yurt-playground
Terminal=true
Categories=Development;
DESKTOP
  installed_kb=$(du -sk "$pkg/data" | cut -f1)
  # The glibc the host and runtime import, recorded by the desktop-host
  # release beside them (yurt-sandbox scripts/build-desktop-host.sh): what
  # the package must depend on, or apt installs a package whose first run
  # dies with "version GLIBC_x.y not found" (yurt-sandbox#250). A release
  # from before that file declares nothing, as before.
  depends=""
  if [ -f "$runtime/GLIBC_REQUIRED" ]; then
    depends="Depends: libc6 (>= $(cat "$runtime/GLIBC_REQUIRED"))"$'\n'
  fi
  # xdg-utils only opens the browser; on a headless box it dragged 243
  # packages of X11 and Mesa in as a Recommends (#91). The launcher prints
  # the URL either way.
  cat > "$pkg/control/control" <<CONTROL
Package: yurt-playground
Version: $version
Section: devel
Priority: optional
Architecture: $deb_arch
Installed-Size: $installed_kb
${depends}Suggests: xdg-utils
Maintainer: YurtOS <noreply@yurtos.org>
Homepage: https://github.com/YurtOS/yurt-playground
Description: Yurt playground desktop app
 A Linux sandbox on the Yurt kernel, with CPython, NumPy and Jupyter,
 running natively on this machine and shown in the default browser.
 Run yurt-playground from a terminal.
CONTROL
  # Root-owned members, whichever tar this is (GNU or bsdtar).
  if tar --version 2>/dev/null | grep -q GNU; then own=(--owner=0 --group=0); else own=(--uid 0 --gid 0); fi
  tar -czf "$pkg/control.tar.gz" "${own[@]}" -C "$pkg/control" control
  tar -czf "$pkg/data.tar.gz" "${own[@]}" -C "$pkg/data" .
  printf '2.0\n' > "$pkg/debian-binary"
  deb=dist-desktop/Yurt-Playground-$target.deb
  rm -f "$deb"
  # -S: no symbol table; macOS's ar otherwise runs ranlib and emits an
  # archive of nothing but __.SYMDEF.
  (cd "$pkg" && ar -r -c -S "../../../$deb" debian-binary control.tar.gz data.tar.gz)
  rm -rf "$pkg"
  echo "built $out/yurt-playground/ and $deb"
  exit 0
fi

app="$out/Yurt Playground.app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp "$out/yurt-playground" "$app/Contents/MacOS/yurt-playground"
cp -R "$site/dist" "$app/Contents/Resources/dist"
cp -R "$site/runtime" "$app/Contents/Resources/runtime"
rm -rf "$site"
# Finder launches a bundle without a terminal; the launcher opens one so the
# server has a window whose closing stops it.
cat > "$app/Contents/MacOS/Yurt Playground" <<'LAUNCH'
#!/bin/bash
exec open -a Terminal "$(dirname "$0")/yurt-playground"
LAUNCH
chmod +x "$app/Contents/MacOS/Yurt Playground"
cat > "$app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Yurt Playground</string>
  <key>CFBundleDisplayName</key><string>Yurt Playground</string>
  <key>CFBundleIdentifier</key><string>org.yurtos.playground</string>
  <key>CFBundleVersion</key><string>$version</string>
  <key>CFBundleShortVersionString</key><string>$version</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>Yurt Playground</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
</dict>
</plist>
PLIST
# The disk image: the app and an Applications shortcut to drag it onto.
# hdiutil is macOS-only, which is where the macOS bundles are built.
dmg_stage=$out/dmg
rm -rf "$dmg_stage"
mkdir -p "$dmg_stage"
cp -R "$app" "$dmg_stage/"
ln -s /Applications "$dmg_stage/Applications"
dmg=dist-desktop/Yurt-Playground-$target.dmg
rm -f "$dmg"
# Not -quiet: it hides hdiutil's own error, and the step then fails with
# nothing but "exit code 1" (main runs 35111653403 and 35147478125, both on
# the second target of the loop). "Resource busy" is a known intermittent
# on GitHub's macOS runners, so the create is retried a few times.
attempt=1
until hdiutil create -volname "Yurt Playground" -srcfolder "$dmg_stage" -ov -format UDZO "$dmg"; do
  if [ "$attempt" -ge 4 ]; then
    echo "build-desktop: hdiutil create failed $attempt times for $target" >&2
    exit 1
  fi
  echo "build-desktop: hdiutil create failed (attempt $attempt), retrying" >&2
  attempt=$((attempt + 1))
  sleep 3
done
rm -rf "$dmg_stage"
echo "built \"$app\" and $dmg"
