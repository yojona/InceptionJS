#!/usr/bin/env bash
source "$(dirname "$0")/../lib.sh"
use_toolchain
installed lib/libpng.a && exit 0

step libpng
src=$(unpack_pinned libpng)
cmake_install libpng "$src" \
  -DPNG_SHARED=OFF -DPNG_STATIC=ON -DPNG_TESTS=OFF -DPNG_TOOLS=OFF \
  -DZLIB_ROOT="$SYSROOT"
