#!/usr/bin/env bash
# The whole build, from a clean machine: toolchain, dependencies, the engine's
# file system image, the engine itself and its licenses.txt. Each step skips work already done.
set -euo pipefail
here="$(dirname "$0")"
bash "$here/toolchain.sh"
bash "$here/deps.sh"
bash "$here/webkit.sh" >/dev/null
bash "$here/fs.sh"
bash "$here/engine.sh"
bash "$here/licenses.sh"
