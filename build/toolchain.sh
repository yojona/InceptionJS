#!/usr/bin/env bash
# Installs the pinned Emscripten SDK into the work directory.
source "$(dirname "$0")/lib.sh"

for tool in git curl cmake ninja make python3 pkg-config tar xz unzip ruby perl gperf bison flex; do
  command -v "$tool" >/dev/null || fail "missing host tool: $tool"
done

if [ ! -d "$TOOLCHAIN/.git" ]; then
  step "fetching emsdk"
  logged emsdk-clone git clone --depth 1 "$EMSDK_REPO" "$TOOLCHAIN"
fi

if [ "$(cat "$TOOLCHAIN/.inception-version" 2>/dev/null)" != "$EMSDK_VERSION" ]; then
  step "installing emscripten $EMSDK_VERSION"
  logged emsdk-install "$TOOLCHAIN/emsdk" install "$EMSDK_VERSION"
  logged emsdk-activate "$TOOLCHAIN/emsdk" activate "$EMSDK_VERSION"
  printf '%s\n' "$EMSDK_VERSION" > "$TOOLCHAIN/.inception-version"
fi

use_toolchain
emcc --version | head -1
