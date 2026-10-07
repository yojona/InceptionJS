# Shared by every build script: paths, logging, downloads, and the two build
# styles dependencies use (CMake and autotools), all targeting one wasm sysroot.
# Sourced, not executed.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Everything the build produces lives under WORK (toolchain, sources, sysroot,
# build trees, logs). It is not committed. Keep its absolute path stable across
# machines: ccache keys include it.
WORK="${INCEPTION_WORK:-$ROOT/.work}"
TOOLCHAIN="$WORK/emsdk"
ARCHIVES="$WORK/archives"
SOURCES="$WORK/sources"
DEPS_BUILD="$WORK/deps-build"
SYSROOT="$WORK/sysroot"
LOGS="$WORK/logs"
JOBS="${JOBS:-$(nproc 2>/dev/null || sysctl -n hw.ncpu)}"

source "$ROOT/build/pins.sh"

mkdir -p "$ARCHIVES" "$SOURCES" "$DEPS_BUILD" "$SYSROOT/lib/pkgconfig" "$SYSROOT/include" "$LOGS"

step() { printf '\n== %s\n' "$*"; }
fail() { printf 'error: %s\n' "$*" >&2; exit 1; }

# Runs a command with its output in $LOGS/<name>.log; on failure shows the tail.
logged() {
  local name="$1"; shift
  if ! "$@" >"$LOGS/$name.log" 2>&1; then
    tail -n 40 "$LOGS/$name.log" >&2
    fail "$name failed (full log: $LOGS/$name.log)"
  fi
}

use_toolchain() {
  [ -f "$TOOLCHAIN/emsdk_env.sh" ] || fail "toolchain missing: run build/toolchain.sh"
  # shellcheck disable=SC1091
  source "$TOOLCHAIN/emsdk_env.sh" >/dev/null 2>&1
  # The engine runs on a pthread, so every library shares its threading ABI.
  export CFLAGS="-O2 -pthread" CXXFLAGS="-O2 -pthread"
  export PKG_CONFIG_LIBDIR="$SYSROOT/lib/pkgconfig"
}

sha256_of() {
  if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

# Downloads and verifies a pinned archive, then extracts it into a clean
# $SOURCES/<name> (top-level directory stripped). Prints the source path.
unpack_pinned() {
  local name="$1"
  local key="${name//-/_}"
  local url_var="${key}_URL" sum_var="${key}_SHA256"
  local url="${!url_var}" want="${!sum_var}"
  local archive="$ARCHIVES/$name.${url##*.}"
  if [ ! -f "$archive" ] || [ "$(sha256_of "$archive")" != "$want" ]; then
    curl -fsSL --retry 3 -o "$archive.part" "$url" || fail "download failed: $url"
    mv "$archive.part" "$archive"
  fi
  [ "$(sha256_of "$archive")" = "$want" ] || fail "checksum mismatch for $name ($url)"
  local dir="$SOURCES/$name"
  rm -rf "$dir"
  mkdir -p "$dir"
  case "$archive" in
    *.zip)
      local tmp="$dir.unzip"
      rm -rf "$tmp"; mkdir -p "$tmp"
      (cd "$tmp" && unzip -q "$archive")
      mv "$tmp"/*/* "$dir"/
      rm -rf "$tmp" ;;
    *) tar -xf "$archive" -C "$dir" --strip-components=1 ;;
  esac
  printf '%s\n' "$dir"
}

# True when a dependency already installed its marker file into the sysroot.
installed() { [ -e "$SYSROOT/$1" ]; }

# Static CMake build of <source dir> installed into the sysroot.
cmake_install() {
  local name="$1" src="$2"; shift 2
  local build="$DEPS_BUILD/$name"
  rm -rf "$build"
  logged "$name-configure" emcmake cmake -S "$src" -B "$build" -G Ninja \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_INSTALL_PREFIX="$SYSROOT" \
    -DCMAKE_FIND_ROOT_PATH="$SYSROOT" \
    -DCMAKE_PREFIX_PATH="$SYSROOT" \
    -DBUILD_SHARED_LIBS=OFF \
    "$@"
  logged "$name-build" ninja -C "$build" install
}

# Static autotools build of <source dir> installed into the sysroot.
autotools_install() {
  local name="$1" src="$2"; shift 2
  (
    cd "$src"
    logged "$name-configure" emconfigure ./configure \
      --host=wasm32-unknown-emscripten --prefix="$SYSROOT" \
      --disable-shared --enable-static "$@"
    logged "$name-build" emmake make -j"$JOBS"
    logged "$name-install" emmake make install
  )
}
