#!/usr/bin/env bash
source "$(dirname "$0")/../lib.sh"
use_toolchain
# The engine's file system has no shared memory mapping and keeps temporary
# tables in memory; rebuilt whenever these flags change.
FLAGS="-DSQLITE_THREADSAFE=1 -DSQLITE_OMIT_LOAD_EXTENSION -DSQLITE_ENABLE_FTS5 -DSQLITE_TEMP_STORE=3 -DSQLITE_MAX_MMAP_SIZE=0 -DSQLITE_DISABLE_DIRSYNC"
stamp="$SYSROOT/lib/.sqlite-flags"
[ -f "$SYSROOT/lib/libsqlite3.a" ] && [ "$(cat "$stamp" 2>/dev/null)" = "$FLAGS" ] && exit 0

step sqlite
src=$(unpack_pinned sqlite)
(
  cd "$src"
  logged sqlite-build emcc $CFLAGS -c sqlite3.c -o sqlite3.o $FLAGS
  logged sqlite-archive emar rcs libsqlite3.a sqlite3.o
)
cp "$src/libsqlite3.a" "$SYSROOT/lib/"
cp "$src/sqlite3.h" "$src/sqlite3ext.h" "$SYSROOT/include/"
printf '%s' "$FLAGS" > "$stamp"
cat > "$SYSROOT/lib/pkgconfig/sqlite3.pc" <<EOF
prefix=$SYSROOT
libdir=\${prefix}/lib
includedir=\${prefix}/include
Name: SQLite
Description: SQL database engine
Version: 3.46.1
Libs: -L\${libdir} -lsqlite3
Cflags: -I\${includedir}
EOF
