#!/usr/bin/env bash
# ICU cross-compiles in two passes: a native build provides the data tools, the
# wasm build uses them. Data ships as an archive the engine embeds in its FS.
source "$(dirname "$0")/../lib.sh"
installed lib/libicuuc.a && exit 0

step icu
src=$(unpack_pinned icu)
# ICU ships no platform fragment for emscripten; the Linux one works under emmake.
cp -f "$src/source/config/mh-linux" "$src/source/config/mh-unknown"

host="$DEPS_BUILD/icu-host"
rm -rf "$host"; mkdir -p "$host"
(cd "$host" && logged icu-host-configure "$src/source/configure" --disable-tests --disable-samples \
  && logged icu-host-build make -j"$JOBS")

use_toolchain
wasm="$DEPS_BUILD/icu-wasm"
rm -rf "$wasm"; mkdir -p "$wasm"
(
  cd "$wasm"
  logged icu-configure emconfigure "$src/source/configure" \
    --build="$(sh "$src/source/config.guess")" --host=wasm32-unknown-emscripten \
    --with-cross-build="$host" \
    --enable-static --disable-shared --disable-tests --disable-samples \
    --disable-extras --disable-tools --disable-dyload \
    --with-data-packaging=archive --prefix="$SYSROOT"
  logged icu-build emmake make -j"$JOBS"
  logged icu-install emmake make install
)
# The release ships the common data archive prebuilt for little-endian ASCII
# targets, which wasm is; install it directly instead of depending on whether
# configure decided the data directory needs building.
dat="icudt${ICU_DATA_VERSION%%.*}l.dat"
mkdir -p "$SYSROOT/share/icu/$ICU_DATA_VERSION"
cp -f "$src/source/data/in/$dat" "$SYSROOT/share/icu/$ICU_DATA_VERSION/$dat"
