#!/bin/bash
# Double-click once: puts "FMH DRILL.app" on your Desktop. Double-clicking that icon starts
# server.py in the background (or just opens the browser if it is already running).
# Re-run this file if you move the drill folder.
set -e
DRILL="$(cd "$(dirname "$0")" && pwd)"
APP="$HOME/Desktop/FMH DRILL.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

cat > "$APP/Contents/MacOS/FMH DRILL" <<LAUNCH
#!/bin/bash
cd "$DRILL" || { osascript -e 'display alert "FMH DRILL" message "Der Ordner drill/ wurde nicht gefunden. make-desktop-icon.command nochmals ausführen."'; exit 1; }
if ! command -v python3 >/dev/null 2>&1; then
  osascript -e 'display alert "FMH DRILL" message "python3 fehlt. Im Terminal: xcode-select --install"'
  exit 1
fi
mkdir -p userdata
# server.py opens the browser itself; if it is already running on 8765 it only opens the browser and exits.
nohup python3 server.py >> userdata/server.log 2>&1 &
LAUNCH
chmod +x "$APP/Contents/MacOS/FMH DRILL"

cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>FMH DRILL</string>
  <key>CFBundleDisplayName</key><string>FMH DRILL</string>
  <key>CFBundleIdentifier</key><string>local.fmhdrill.launcher</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>FMH DRILL</string>
  <key>CFBundleIconFile</key><string>icon</string>
  <key>LSUIElement</key><true/>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
</dict></plist>
PLIST

# icon: build the .icns from launcher/icon.png with the macOS tools sips + iconutil
ICONSET="$(mktemp -d)/icon.iconset"
mkdir -p "$ICONSET"
for size in 16 32 64 128 256 512 1024; do
  sips -z $size $size "$DRILL/launcher/icon.png" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
done
cp "$ICONSET/icon_32x32.png" "$ICONSET/icon_16x16@2x.png"; cp "$ICONSET/icon_64x64.png" "$ICONSET/icon_32x32@2x.png"
cp "$ICONSET/icon_256x256.png" "$ICONSET/icon_128x128@2x.png"; cp "$ICONSET/icon_512x512.png" "$ICONSET/icon_256x256@2x.png"
cp "$ICONSET/icon_1024x1024.png" "$ICONSET/icon_512x512@2x.png"; rm "$ICONSET/icon_64x64.png" "$ICONSET/icon_1024x1024.png"
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/icon.icns"
touch "$APP"
# the app was created locally, so Gatekeeper does not quarantine it; clear the flag anyway
xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true
echo "Fertig: $APP  →  Doppelklick startet FMH DRILL."
osascript -e 'display notification "FMH DRILL liegt jetzt auf dem Desktop." with title "FMH DRILL"' 2>/dev/null || true
