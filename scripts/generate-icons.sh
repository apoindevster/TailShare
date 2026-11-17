#!/usr/bin/env bash
set -euo pipefail

# Optional artwork tooling only: normal builds use the committed PNGs.
# ImageMagick 6 (convert) and 7 (magick) are supported.
cd "$(dirname "$0")/.."
if command -v magick >/dev/null 2>&1; then
  renderer=magick
elif command -v convert >/dev/null 2>&1; then
  renderer=convert
else
  echo "Install ImageMagick to regenerate the home-screen icons." >&2
  exit 1
fi

source_icon=docs/images/tailshare-icon.svg
for size in 180 192 512; do
  output="public/icon-${size}.png"
  if [[ "$size" == 180 ]]; then output=public/apple-touch-icon.png; fi
  "$renderer" "$source_icon" -resize "${size}x${size}" -strip "PNG24:$output"
done
# Keep every part of the mark inside Android's central 40%-radius safe circle.
"$renderer" "$source_icon" -resize 80% -gravity center -background '#0b101b' \
  -extent 512x512 -strip PNG24:public/icon-maskable-512.png
