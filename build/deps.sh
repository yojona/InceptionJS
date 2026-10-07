#!/usr/bin/env bash
# Builds every engine dependency into the wasm sysroot, in dependency order.
# Each script skips itself when already installed, so this is safe to re-run.
source "$(dirname "$0")/lib.sh"

ORDER=(
  zlib libpng libjpeg-turbo libwebp
  brotli freetype icu harfbuzz
  libxml2 sqlite
  openssl nghttp2 libpsl curl
  fontconfig
)

for dep in "${ORDER[@]}"; do
  bash "$ROOT/build/deps/$dep.sh"
done
step "dependencies ready in $SYSROOT"
