#!/usr/bin/env bash
# Fontconfig is configured for the paths the engine's embedded FS uses at run
# time (/etc/fonts, /usr/share/fonts). It installs through a staging directory so
# nothing is written to the build machine's /etc.
source "$(dirname "$0")/../lib.sh"
use_toolchain
installed lib/pkgconfig/fontconfig.pc && installed etc/fonts/fonts.conf && exit 0

step fontconfig
src=$(unpack_pinned fontconfig)
# The shipped config.sub predates the emscripten target; use the host's newer one.
sub=""
for candidate in /usr/share/misc/config.sub "$(automake --print-libdir 2>/dev/null)/config.sub"; do
  if [ -f "$candidate" ] && grep -q emscripten "$candidate"; then sub="$candidate"; break; fi
done
[ -n "$sub" ] || fail "no emscripten-aware config.sub on this host (install autotools-dev)"
cp -f "$sub" "$src/config.sub"
stage="$DEPS_BUILD/fontconfig-stage"
rm -rf "$stage"
(
  cd "$src"
  # FreeType pulls brotli in for WOFF2; fontconfig's test programs link it.
  logged fontconfig-configure emconfigure ./configure \
    --host=wasm32-unknown-emscripten --prefix="$SYSROOT" \
    --disable-shared --enable-static --disable-docs \
    --enable-libxml2 --sysconfdir=/etc \
    --with-default-fonts=/usr/share/fonts \
    --with-cache-dir=/var/cache/fontconfig \
    LIBXML2_CFLAGS="-I$SYSROOT/include/libxml2" \
    LIBXML2_LIBS="-L$SYSROOT/lib -lxml2 -licuuc -licudata -lz" \
    LIBS="-L$SYSROOT/lib -lbrotlidec -lbrotlicommon"
  logged fontconfig-build emmake make -j"$JOBS"
  logged fontconfig-install emmake make install DESTDIR="$stage"
)
cp -a "$stage$SYSROOT/." "$SYSROOT/"
mkdir -p "$SYSROOT/etc"
cp -a "$stage/etc/." "$SYSROOT/etc/"
