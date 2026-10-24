#!/bin/bash
# The macOS app icon, made by Apple's own iconutil (macOS only).
#
#   bash scripts/build-mac-icon.sh [source.png] [out.icns]      (default: assets/typd.png -> build/icon.icns)
#
# package.json build.mac.icon names build/icon.icns. electron-builder used to make the .icns from
# assets/typd.png itself, and its file was wrong: the 128@2x slot held a 512 px image and the 256@2x
# slot a 1024 px one, and the 16 and 32 px images sat in PNG slots (icp4/icp5) where iconutil writes
# ARGB ones (ic04/ic05) -- Finder's small icons (list view) came out broken. Here every size is
# resampled by sips from the 1024 px master into a standard .iconset, and iconutil packs it, so the
# file holds exactly what Apple's tools make. scripts/check-icns.js then checks every slot's size;
# the Mac CI checks the packaged app's icon the same way and reads it back with iconutil.
set -euo pipefail
cd "$(dirname "$0")/.."
SRC=${1:-assets/typd.png}
OUT=${2:-build/icon.icns}
command -v iconutil >/dev/null || { echo "iconutil is macOS only"; exit 1; }
w=$(sips -g pixelWidth "$SRC" | awk '/pixelWidth/ {print $2}')
h=$(sips -g pixelHeight "$SRC" | awk '/pixelHeight/ {print $2}')
[ "$w" = 1024 ] && [ "$h" = 1024 ] || { echo "$SRC is ${w}x${h}; the icon master must be 1024x1024"; exit 1; }
tmp=$(mktemp -d)
set_dir="$tmp/typd.iconset"
mkdir -p "$set_dir"
for n in 16 32 128 256 512; do
  sips -z "$n" "$n" "$SRC" --out "$set_dir/icon_${n}x${n}.png" >/dev/null
  sips -z $((n * 2)) $((n * 2)) "$SRC" --out "$set_dir/icon_${n}x${n}@2x.png" >/dev/null
done
mkdir -p "$(dirname "$OUT")"
iconutil -c icns "$set_dir" -o "$OUT"
rm -rf "$tmp"
node scripts/check-icns.js "$OUT"
echo "built $OUT from $SRC with iconutil"
