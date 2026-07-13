#!/usr/bin/env bash
#
# bundle-mac.sh — package termset as a double-clickable macOS .app bundle.
#
# Produces  dist/termset.app  containing the release `terms` binary, a proper
# .icns icon rasterized from termset.svg, and an Info.plist. The bundle is
# ad-hoc code-signed so Gatekeeper lets you right-click → Open it (no Apple
# Developer account required — that comes later for notarization).
#
# Usage:
#   bash scripts/bundle-mac.sh              # build dist/termset.app
#   INSTALL=1 bash scripts/bundle-mac.sh    # also copy it into /Applications
#
# Single source of truth for the art is termset.svg (same file the README and
# the Linux launcher use). We rasterize it with the best renderer available:
# rsvg-convert → headless Chrome → qlmanage → ImageMagick.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(dirname "$SCRIPT_DIR")"
cd "$REPO"

APP_NAME="termset"                 # user-facing product name (the .app is termset.app)
BIN_NAME="terms"                   # the real binary, dropped in MacOS/
LAUNCH_NAME="termset"              # the bundle's CFBundleExecutable: a launcher shim
BUNDLE_ID="com.termset.terms"
SVG_SRC="$REPO/termset.svg"
TEMPLATE_SRC="$REPO/assets/default-termset.yml"
# The "home" workspace the app opens when double-clicked (seeded on first run).
# Matches the Linux launcher (scripts/install-icon.sh).
HOME_WORKSPACE="\$HOME/.terms/workspace01.yaml"
DIST="$REPO/dist"
APP="$DIST/$APP_NAME.app"
CONTENTS="$APP/Contents"
MACOS="$CONTENTS/MacOS"
RES="$CONTENTS/Resources"

VERSION="$(sed -n 's/^version = "\(.*\)"/\1/p' "$REPO/Cargo.toml" | head -1)"
VERSION="${VERSION:-0.1.0}"

log() { printf '  %s\n' "$*"; }

[ -f "$SVG_SRC" ] || { echo "error: $SVG_SRC not found" >&2; exit 1; }

# 1. Build the release binary.
BIN="$REPO/target/release/$BIN_NAME"
log "building release binary…"
cargo build --release
[ -x "$BIN" ] || { echo "error: $BIN not found after build" >&2; exit 1; }

# 2. Rasterize termset.svg → a 1024px master PNG, then downscale into an iconset.
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
MASTER="$WORK/master.png"

render_master() {
    # rsvg-convert — crispest, honours gradients.
    if command -v rsvg-convert >/dev/null; then
        rsvg-convert -w 1024 -h 1024 "$SVG_SRC" -o "$MASTER" && return 0
    fi
    # Headless Chrome — full SVG/gradient fidelity via Blink.
    local chrome="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    [ -x "$chrome" ] || chrome="$(command -v google-chrome-stable || command -v chromium || true)"
    if [ -n "$chrome" ] && [ -x "$chrome" ]; then
        cp "$SVG_SRC" "$WORK/termset.svg"
        cat > "$WORK/icon.html" <<'HTML'
<!doctype html><meta charset=utf-8>
<style>html,body{margin:0;padding:0;background:transparent}
img{width:1024px;height:1024px;display:block}</style>
<img src="termset.svg">
HTML
        "$chrome" --headless --disable-gpu --hide-scrollbars \
            --force-device-scale-factor=1 --window-size=1024,1024 \
            --default-background-color=00000000 \
            --screenshot="$MASTER" "$WORK/icon.html" >/dev/null 2>&1 \
            && [ -s "$MASTER" ] && return 0
    fi
    # QuickLook — usually renders SVG on modern macOS.
    if command -v qlmanage >/dev/null; then
        qlmanage -t -s 1024 -o "$WORK" "$SVG_SRC" >/dev/null 2>&1 \
            && mv "$WORK"/termset.svg.png "$MASTER" 2>/dev/null && [ -s "$MASTER" ] && return 0
    fi
    # ImageMagick — last resort (internal MSVG drops gradients; better than nothing).
    if command -v magick >/dev/null; then
        magick -background none -density 512 "$SVG_SRC" -resize 1024x1024 "$MASTER" && return 0
    fi
    return 1
}

log "rasterizing icon from termset.svg…"
render_master || { echo "error: no usable SVG renderer found" >&2; exit 1; }

ICONSET="$WORK/$APP_NAME.iconset"
mkdir -p "$ICONSET"
gen() { # gen <pixels> <iconset-filename>
    sips -z "$1" "$1" "$MASTER" --out "$ICONSET/$2" >/dev/null
}
gen 16   icon_16x16.png
gen 32   icon_16x16@2x.png
gen 32   icon_32x32.png
gen 64   icon_32x32@2x.png
gen 128  icon_128x128.png
gen 256  icon_128x128@2x.png
gen 256  icon_256x256.png
gen 512  icon_256x256@2x.png
gen 512  icon_512x512.png
cp "$MASTER" "$ICONSET/icon_512x512@2x.png"

# 3. Assemble the bundle from scratch (clean each run).
rm -rf "$APP"
mkdir -p "$MACOS" "$RES"
cp "$BIN" "$MACOS/$BIN_NAME"
chmod +x "$MACOS/$BIN_NAME"
iconutil -c icns "$ICONSET" -o "$RES/$APP_NAME.icns"
log "icon  -> $RES/$APP_NAME.icns"

# Bundle the default-layout template so the launcher can seed the home
# workspace at runtime without needing the repo checkout.
cp "$TEMPLATE_SRC" "$RES/default-termset.yml"

# The launcher (CFBundleExecutable): a double-clicked .app starts with CWD=/,
# so `terms` alone would fall back to the CWD-based default layout. Instead we
# seed a real home workspace on first run and open it explicitly — the same
# ~/.terms/workspace01.yaml the Linux launcher uses. The `terms` CLI keeps its
# per-directory ./termset.yml behavior; this default lives only in the .app.
cat > "$MACOS/$LAUNCH_NAME" <<LAUNCHER
#!/bin/bash
# termset.app launcher — seeds \$HOME/.terms/workspace01.yaml then opens it.
set -e
DIR="\$(cd "\$(dirname "\$0")" && pwd)"
RES="\$DIR/../Resources"
WORKSPACE="$HOME_WORKSPACE"
if [ ! -e "\$WORKSPACE" ]; then
    mkdir -p "\$(dirname "\$WORKSPACE")"
    # Strip template comments and fill placeholders (session dir -> \$HOME).
    grep -v '^#' "\$RES/default-termset.yml" \\
        | sed -e "s|{{name}}|workspace01|g" -e "s|{{dir}}|\$HOME|g" \\
        > "\$WORKSPACE"
fi
exec "\$DIR/$BIN_NAME" "\$WORKSPACE"
LAUNCHER
chmod +x "$MACOS/$LAUNCH_NAME"
log "launcher -> $MACOS/$LAUNCH_NAME  (opens ~/.terms/workspace01.yaml)"

cat > "$CONTENTS/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleName</key>              <string>$APP_NAME</string>
	<key>CFBundleDisplayName</key>       <string>$APP_NAME</string>
	<key>CFBundleIdentifier</key>        <string>$BUNDLE_ID</string>
	<key>CFBundleExecutable</key>        <string>$LAUNCH_NAME</string>
	<key>CFBundleIconFile</key>          <string>$APP_NAME</string>
	<key>CFBundlePackageType</key>       <string>APPL</string>
	<key>CFBundleShortVersionString</key><string>$VERSION</string>
	<key>CFBundleVersion</key>           <string>$VERSION</string>
	<key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
	<key>LSMinimumSystemVersion</key>    <string>10.13</string>
	<key>NSHighResolutionCapable</key>   <true/>
	<key>LSApplicationCategoryType</key> <string>public.app-category.developer-tools</string>
</dict>
</plist>
PLIST
log "plist -> $CONTENTS/Info.plist  (v$VERSION)"

# 4. Ad-hoc code-sign so Gatekeeper allows a right-click → Open. Without an
#    Apple Developer identity this is not notarized, but ad-hoc signing keeps
#    the arm64 binary launchable and quiets the "damaged" dialog.
codesign --force --deep --sign - "$APP" >/dev/null 2>&1 \
    && log "signed (ad-hoc)" || log "codesign skipped (unavailable)"

echo
echo "Built $APP  (v$VERSION)"
echo "First launch: right-click the app → Open → Open (bypasses Gatekeeper once)."

# 5. Optional: install into /Applications.
if [ "${INSTALL:-}" = "1" ]; then
    rm -rf "/Applications/$APP_NAME.app"
    cp -R "$APP" "/Applications/$APP_NAME.app"
    echo "Installed -> /Applications/$APP_NAME.app"
fi
