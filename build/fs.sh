#!/usr/bin/env bash
# Stages the engine's file system image: what WebKit and its libraries read at
# run time. It is packaged into the engine as a preloaded data file.
#   /etc/fonts           fontconfig configuration (from the sysroot install)
#   /usr/share/fonts     fallback fonts for when pages bring none
#   /usr/share/icu       ICU data archive (ICU_DATA points here)
#   /etc/ssl/cacert.pem  trust store for TLS, which terminates in the engine
#   /usr/share/inception/resources  WebKit's built-in images (broken image...)
source "$(dirname "$0")/lib.sh"

FS="$WORK/fs"
step "staging engine file system"
rm -rf "$FS"
mkdir -p "$FS/etc" "$FS/usr/share/fonts" "$FS/usr/share/icu" "$FS/etc/ssl" "$FS/var/cache/fontconfig" "$FS/tmp"

# conf.d holds symlinks into the install prefix; the image needs the files.
mkdir -p "$FS/etc/fonts/conf.d"
cp "$SYSROOT/etc/fonts/fonts.conf" "$FS/etc/fonts/"
for link in "$SYSROOT"/etc/fonts/conf.d/*.conf; do
  target="$SYSROOT/share/fontconfig/conf.avail/$(basename "$link")"
  if [ -f "$link" ]; then cp -L "$link" "$FS/etc/fonts/conf.d/"
  elif [ -f "$target" ]; then cp "$target" "$FS/etc/fonts/conf.d/"
  fi
done
dat="icudt${ICU_DATA_VERSION%%.*}l.dat"
cp "$SYSROOT/share/icu/$ICU_DATA_VERSION/$dat" "$FS/usr/share/icu/$dat"

fonts=/usr/share/fonts/truetype/dejavu
[ -d "$fonts" ] || fail "no DejaVu fonts at $fonts (the build image installs them)"
cp "$fonts"/*.ttf "$FS/usr/share/fonts/"
# Emoji and Chinese, Japanese and Korean text; only the regular CJK weight,
# which the font engine emboldens when a page asks for bold.
for font in /usr/share/fonts/truetype/noto/NotoColorEmoji.ttf /usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc; do
  [ -f "$font" ] || fail "missing $font (the build image installs it)"
  cp "$font" "$FS/usr/share/fonts/"
done

resources="$WORK/webkit/Source/WebCore/Resources"
[ -d "$resources" ] || fail "no WebKit checkout at $WORK/webkit; run build/webkit.sh first"
mkdir -p "$FS/usr/share/inception/resources"
cp "$resources"/missingImage*.png "$resources"/panIcon.png "$FS/usr/share/inception/resources/"

bundle=/etc/ssl/certs/ca-certificates.crt
[ -f "$bundle" ] || fail "no CA bundle at $bundle"
cp "$bundle" "$FS/etc/ssl/cacert.pem"

du -sh "$FS" | cut -f1
