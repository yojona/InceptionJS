#!/usr/bin/env bash
# The whole build, from a clean machine: toolchain, dependencies, the engine's
# file system image and the engine itself. Each step skips work already done.
set -euo pipefail
here="$(dirname "$0")"
bash "$here/toolchain.sh"
bash "$here/deps.sh"
bash "$here/webkit.sh" >/dev/null
bash "$here/fs.sh"
bash "$here/engine.sh"
