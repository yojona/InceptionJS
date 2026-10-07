#!/usr/bin/env bash
source "$(dirname "$0")/../lib.sh"
use_toolchain
installed lib/libnghttp2.a && exit 0

step nghttp2
src=$(unpack_pinned nghttp2)
cmake_install nghttp2 "$src" \
  -DENABLE_LIB_ONLY=ON -DBUILD_STATIC_LIBS=ON -DENABLE_DOC=OFF
