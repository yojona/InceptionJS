#!/usr/bin/env bash
source "$(dirname "$0")/../lib.sh"
use_toolchain
installed lib/libpsl.a && exit 0

step libpsl
src=$(unpack_pinned libpsl)
autotools_install libpsl "$src" --enable-runtime=libicu --enable-builtin
# A static libpsl built on ICU needs ICU at link time; its .pc does not say so.
pc="$SYSROOT/lib/pkgconfig/libpsl.pc"
grep -q '^Requires.private:.*icu-uc' "$pc" || printf 'Requires.private: icu-uc\n' >> "$pc"
