#!/usr/bin/env bash
# Regenerates web/downloading.mp4, the clip Stremio plays when a freshly added
# torrent has nothing on disk yet. Committed as a binary so the build needs no
# ffmpeg; run this only when changing the wording or look.
set -euo pipefail

font=${FONT:-/usr/share/fonts/TTF/DejaVuSans-Bold.ttf}
out=web/downloading.mp4

ffmpeg -y \
  -f lavfi -i "color=c=0x0B0F14:s=854x480:r=12:d=6" \
  -f lavfi -i "anullsrc=r=44100:cl=stereo" \
  -vf "drawtext=text='DEBRIDARR':fontfile=$font:fontcolor=0x4FD1C5:fontsize=56:x=(w-text_w)/2:y=176,\
drawtext=text='This torrent is still downloading':fontfile=$font:fontcolor=0xF2F5F7:fontsize=30:x=(w-text_w)/2:y=266,\
drawtext=text='Close this stream and open it again shortly':fontfile=$font:fontcolor=0x9AA5B1:fontsize=23:x=(w-text_w)/2:y=320" \
  -c:v libx264 -pix_fmt yuv420p -profile:v baseline -level 3.0 -preset veryslow -crf 30 -g 24 \
  -c:a aac -b:a 32k -shortest -movflags +faststart \
  "$out"

echo "wrote $out"
