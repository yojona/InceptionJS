#!/usr/bin/env bash
source "$(dirname "$0")/../lib.sh"
use_toolchain
installed lib/libxml2.a && exit 0

step libxml2
src=$(unpack_pinned libxml2)
cmake_install libxml2 "$src" \
  -DLIBXML2_WITH_PYTHON=OFF -DLIBXML2_WITH_LZMA=OFF -DLIBXML2_WITH_ZLIB=ON \
  -DLIBXML2_WITH_ICU=ON -DLIBXML2_WITH_TESTS=OFF -DLIBXML2_WITH_PROGRAMS=OFF \
  -DZLIB_ROOT="$SYSROOT" -DICU_ROOT="$SYSROOT"
