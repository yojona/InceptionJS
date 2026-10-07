#!/usr/bin/env bash
source "$(dirname "$0")/../lib.sh"
use_toolchain
installed lib/libharfbuzz.a && exit 0

step harfbuzz
src=$(unpack_pinned harfbuzz)
cmake_install harfbuzz "$src" \
  -DHB_HAVE_FREETYPE=ON -DHB_HAVE_ICU=ON -DHB_BUILD_UTILS=OFF \
  -DFREETYPE_DIR="$SYSROOT" -DICU_ROOT="$SYSROOT"
