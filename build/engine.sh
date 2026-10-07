#!/usr/bin/env bash
# Configures and builds the engine: WebKit (patched) plus the embedder in
# engine/, linked into one wasm module. Outputs go to $WORK/out/engine.
#
# Env:
#   TARGETS  ninja targets (default: everything the embedder needs)
#   ASAN=1   AddressSanitizer build, in its own build directory
source "$(dirname "$0")/lib.sh"
use_toolchain

SRC="$(bash "$ROOT/build/webkit.sh" | tail -1)"
variant=release
flags="-pthread"
if [ "${ASAN:-0}" = 1 ]; then
  variant=asan
  flags="$flags -fsanitize=address"
fi
BUILD="$WORK/build/engine-$variant"
OUT="$WORK/out/engine"
mkdir -p "$BUILD" "$OUT"

# Re-configure from a fresh cache when the build script, the embedder or the
# patch series change: port option defaults only apply to an empty cache.
config_inputs=$(cat "$ROOT/build/engine.sh" "$ROOT/engine/embedder.cmake" "$ROOT"/patches/webkit/*.patch 2>/dev/null | sha256sum | cut -d' ' -f1)
if [ ! -f "$BUILD/build.ninja" ] || [ "$(cat "$BUILD/.inception-config" 2>/dev/null)" != "$config_inputs" ]; then
  step "configuring engine ($variant)"
  rm -f "$BUILD/CMakeCache.txt"
  logged "engine-configure-$variant" emcmake cmake -G Ninja -S "$SRC" -B "$BUILD" \
    -DPORT=Emscripten \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_C_FLAGS="$flags" -DCMAKE_CXX_FLAGS="$flags" \
    -DCMAKE_FIND_ROOT_PATH="$SYSROOT" \
    -DCMAKE_PREFIX_PATH="$SYSROOT" \
    -DICU_ROOT="$SYSROOT" \
    -DENABLE_STATIC_JSC=ON \
    -DDEVELOPER_MODE=OFF \
    -DWEBKIT_EMBEDDER_CMAKE_FILE="$ROOT/engine/embedder.cmake" \
    -DINCEPTION_FS_DIR="$WORK/fs" \
    -DINCEPTION_HOST_DIR="$ROOT/host"
  printf '%s\n' "$config_inputs" > "$BUILD/.inception-config"
fi

targets=(${TARGETS:-inception-engine})
step "building ${targets[*]} ($variant)"
started=$(date +%s)
logged "engine-build-$variant" ninja -C "$BUILD" -j"$JOBS" -k 0 "${targets[@]}"
echo "built in $(( $(date +%s) - started )) s"

shopt -s nullglob
for f in "$BUILD"/bin/inception-engine.*; do cp -f "$f" "$OUT/"; done
ls -la "$OUT"
