#!/usr/bin/env bash
# Writes licenses.txt next to the engine files: the license texts and
# copyright notices of everything built or packed into them, taken from the
# sources this build downloaded (WebKit, the pinned libraries, Emscripten) and
# from the packages the fonts and certificates come from. Released with the
# engine; THIRD_PARTY_NOTICES.md is the summary of it.
source "$(dirname "$0")/lib.sh"

OUT="$WORK/out/engine"
target="$OUT/licenses.txt"
mkdir -p "$OUT"
step "writing licenses.txt"

section() {
  printf '\n%s\n%s\n\n' "================================================================================" "$1"
}

# Every license-like file at the top of a source tree (and a few known spots).
license_files() {
  local dir="$1"
  find "$dir" -maxdepth 1 -type f \( -iname 'LICENSE*' -o -iname 'LICENCE*' -o -iname 'COPYING*' -o -iname 'COPYRIGHT*' -o -iname 'NOTICE*' -o -iname 'AUTHORS' \) | sort
}

append_tree() {
  local title="$1" dir="$2"
  section "$title"
  local found=0
  while IFS= read -r file; do
    [ -n "$file" ] || continue
    found=1
    printf -- '--- %s\n\n' "${file#"$dir"/}"
    cat "$file"
    printf '\n'
  done < <(license_files "$dir")
  [ "$found" = 1 ] || printf '(no license file found in %s)\n' "$dir"
}

append_file() {
  local title="$1" file="$2"
  section "$title"
  if [ -f "$file" ]; then cat "$file"; else printf '(missing: %s)\n' "$file"; fi
  printf '\n'
}

{
  printf 'Third-party licenses for the InceptionJS engine files\n'
  printf '(inception-engine.js, inception-engine.wasm, inception-engine.data, inception-engine-cjk.ttc)\n\n'
  printf 'InceptionJS itself is Apache-2.0: see LICENSE and NOTICE in the repository.\n'
  printf 'The engine statically links WebKit, which is LGPL: see LGPL.md for your rights\n'
  printf 'and how to rebuild and replace the engine. Corresponding source: the release tag.\n'

  webkit="$WORK/webkit/Source"
  append_file "WebCore: GNU LGPL 2" "$webkit/WebCore/LICENSE-LGPL-2"
  append_file "WebCore: GNU LGPL 2.1" "$webkit/WebCore/LICENSE-LGPL-2.1"
  append_file "WebCore: Apple BSD-style license" "$webkit/WebCore/LICENSE-APPLE"
  append_file "JavaScriptCore: GNU LGPL 2" "$webkit/JavaScriptCore/COPYING.LIB"
  append_tree "WTF" "$webkit/WTF"
  section "bmalloc"
  printf 'Apple BSD-2-Clause style license, in each source file (the same text as\nWebCore'"'"'s LICENSE-APPLE above).\n'
  append_tree "Skia" "$webkit/ThirdParty/skia"

  for name in zlib libpng libjpeg-turbo libwebp brotli freetype icu harfbuzz libxml2 openssl nghttp2 libpsl curl fontconfig; do
    append_tree "$name" "$SOURCES/$name"
  done
  section "sqlite"
  printf 'SQLite is in the public domain (https://www.sqlite.org/copyright.html).\n'
  # ICU keeps its license one level down in its release archive.
  [ -f "$SOURCES/icu/icu4c/LICENSE" ] && append_file "icu (icu4c/LICENSE)" "$SOURCES/icu/icu4c/LICENSE"

  append_tree "Emscripten" "$TOOLCHAIN/upstream/emscripten"
  append_file "musl libc (via Emscripten)" "$TOOLCHAIN/upstream/emscripten/system/lib/libc/musl/COPYRIGHT"
  append_file "LLVM runtime libraries (via Emscripten)" "$TOOLCHAIN/upstream/emscripten/system/lib/libcxx/LICENSE.TXT"

  append_file "DejaVu fonts" /usr/share/doc/fonts-dejavu-core/copyright
  append_file "Noto Sans CJK (inception-engine-cjk.ttc)" /usr/share/doc/fonts-noto-cjk/copyright
  append_file "Noto Color Emoji: SIL Open Font License 1.1" "$ROOT/build/fonts/OFL-1.1.txt"
  append_file "Certificate bundle (Mozilla roots)" /usr/share/doc/ca-certificates/copyright
} > "$target"

printf '%s (%s KB)\n' "$target" "$(( $(wc -c < "$target") / 1024 ))"
