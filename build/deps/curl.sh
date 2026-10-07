#!/usr/bin/env bash
source "$(dirname "$0")/../lib.sh"
use_toolchain
installed lib/libcurl.a && exit 0

step curl
src=$(unpack_pinned curl)
# Only what a browser engine needs: HTTP(S) with HTTP/2 and brotli, websockets,
# file:. No threaded resolver (names resolve through the socket layer), no IPv6.
autotools_install curl "$src" \
  --with-openssl="$SYSROOT" --with-zlib="$SYSROOT" --with-brotli="$SYSROOT" \
  --with-nghttp2="$SYSROOT" --with-libpsl \
  --with-ca-bundle=/etc/ssl/cacert.pem \
  --enable-http --enable-file --enable-websockets \
  --disable-ftp --disable-ldap --disable-ldaps --disable-rtsp \
  --disable-dict --disable-telnet --disable-tftp --disable-pop3 \
  --disable-imap --disable-smtp --disable-gopher --disable-mqtt \
  --disable-smb --disable-manual --disable-ipv6 \
  --disable-threaded-resolver --disable-unix-sockets --disable-ntlm \
  --without-libidn2 --without-zstd --without-librtmp
