#!/usr/bin/env bash
# Fetches WebKit at the pinned commit and applies patches/webkit/*.patch in order.
# The fetch is blobless and sparse (sources and build scripts, no tests), and the
# tree is only reset and re-patched when the series changes, so unchanged runs
# leave file times alone and the build stays incremental.
source "$(dirname "$0")/lib.sh"

SRC="$WORK/webkit"
series_hash=$(cat "$ROOT"/patches/webkit/*.patch | sha256sum | cut -d' ' -f1)

if [ ! -d "$SRC/.git" ]; then
  step "fetching WebKit $WEBKIT_COMMIT"
  git init -q "$SRC"
  git -C "$SRC" remote add origin "$WEBKIT_REPO"
  git -C "$SRC" sparse-checkout set --cone Source Tools/Scripts
  logged webkit-fetch git -C "$SRC" fetch --depth 1 --filter=blob:none origin "$WEBKIT_COMMIT"
  logged webkit-checkout git -C "$SRC" checkout -q --detach FETCH_HEAD
fi

[ "$(git -C "$SRC" rev-parse HEAD)" = "$WEBKIT_COMMIT" ] || fail "WebKit tree is not at $WEBKIT_COMMIT"

if [ "$(cat "$SRC/.inception-series" 2>/dev/null)" != "$series_hash" ]; then
  step "applying WebKit patch series"
  git -C "$SRC" reset -q --hard "$WEBKIT_COMMIT"
  git -C "$SRC" clean -q -fd
  for patch in "$ROOT"/patches/webkit/*.patch; do
    git -C "$SRC" apply --whitespace=nowarn "$patch" || fail "patch does not apply: $(basename "$patch")"
  done
  printf '%s\n' "$series_hash" > "$SRC/.inception-series"
fi
echo "$SRC"
