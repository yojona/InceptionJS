#!/usr/bin/env bash
source "$(dirname "$0")/../lib.sh"
use_toolchain
installed lib/libz.a && exit 0

step zlib
src=$(unpack_pinned zlib)
cmake_install zlib "$src" -DZLIB_BUILD_EXAMPLES=OFF
rm -f "$SYSROOT"/lib/libz.so*

# CMake installs no pkg-config file here, but freetype2.pc requires one.
cat > "$SYSROOT/lib/pkgconfig/zlib.pc" <<EOF
prefix=$SYSROOT
libdir=\${prefix}/lib
includedir=\${prefix}/include
Name: zlib
Description: zlib compression library
Version: 1.3.1
Libs: -L\${libdir} -lz
Cflags: -I\${includedir}
EOF
