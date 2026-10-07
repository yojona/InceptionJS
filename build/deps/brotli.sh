#!/usr/bin/env bash
source "$(dirname "$0")/../lib.sh"
use_toolchain
installed lib/libbrotlidec.a && exit 0

step brotli
src=$(unpack_pinned brotli)
cmake_install brotli "$src" -DBROTLI_DISABLE_TESTS=ON
