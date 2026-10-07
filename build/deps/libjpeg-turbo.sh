#!/usr/bin/env bash
source "$(dirname "$0")/../lib.sh"
use_toolchain
installed lib/libjpeg.a && exit 0

step libjpeg-turbo
src=$(unpack_pinned libjpeg-turbo)
# The SIMD paths are hand-written assembly for native CPUs; wasm uses the C code.
cmake_install libjpeg-turbo "$src" \
  -DWITH_SIMD=0 -DENABLE_SHARED=0 -DENABLE_STATIC=1 -DWITH_TURBOJPEG=0
