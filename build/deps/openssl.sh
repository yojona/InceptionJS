#!/usr/bin/env bash
source "$(dirname "$0")/../lib.sh"
use_toolchain
installed lib/libssl.a && exit 0

step openssl
src=$(unpack_pinned openssl)
(
  cd "$src"
  # Generic 32-bit target, no assembly, no engines/DSOs: wasm has no native code
  # loading. The CA bundle path is the one the engine embeds in its FS.
  logged openssl-configure emconfigure ./Configure linux-generic32 \
    no-asm no-engine no-afalgeng no-hw no-dso no-shared no-async \
    no-tests no-apps no-docs threads \
    --prefix="$SYSROOT" --libdir=lib --openssldir=/etc/ssl \
    -O2 -pthread
  # emconfigure already points CC at emcc; a cross prefix would double it.
  sed -i.orig 's|^CROSS_COMPILE=.*$|CROSS_COMPILE=|' Makefile
  logged openssl-build emmake make -j"$JOBS" build_libs
  logged openssl-install emmake make install_dev
)
