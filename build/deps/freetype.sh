#!/usr/bin/env bash
source "$(dirname "$0")/../lib.sh"
use_toolchain
installed lib/libfreetype.a && exit 0

step freetype
src=$(unpack_pinned freetype)
# Brotli gives FreeType native WOFF2 decoding, which is how web fonts load.
# HarfBuzz is left out here: it is built afterwards on top of FreeType.
cmake_install freetype "$src" \
  -DFT_DISABLE_HARFBUZZ=ON -DFT_DISABLE_BZIP2=ON \
  -DFT_DISABLE_BROTLI=OFF -DFT_REQUIRE_BROTLI=ON \
  -DFT_REQUIRE_ZLIB=ON -DFT_REQUIRE_PNG=ON \
  -DZLIB_ROOT="$SYSROOT" \
  -DBROTLIDEC_INCLUDE_DIRS="$SYSROOT/include" \
  -DBROTLIDEC_LIBRARIES="$SYSROOT/lib/libbrotlidec.a;$SYSROOT/lib/libbrotlicommon.a"
