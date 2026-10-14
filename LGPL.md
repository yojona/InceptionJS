# WebKit, the LGPL and your right to rebuild the engine

InceptionJS is licensed under the Apache License 2.0 (see [LICENSE](LICENSE)). The
**engine** files it loads (`inception-engine.js`, `inception-engine.wasm`,
`inception-engine.data`) are different: they are one WebAssembly program that
statically links **WebKit** (WebCore and JavaScriptCore) with our embedder and a set of
libraries. WebKit is not ours. Its files are licensed one by one, mostly under the GNU
Lesser General Public License (LGPL 2 and 2.1, "or later" where the file says so) and
under Apple's BSD-2-Clause style license. This document says what that means and how
you can modify and replace the engine.

This is a plain description, not legal advice.

## What is in the engine

| Part | Where the source is | License |
| --- | --- | --- |
| WebKit (WebCore, JavaScriptCore, WTF, bundled Skia) | https://github.com/WebKit/WebKit at commit `aec9d2ad958e716ab4bca4bf03007e6edac7323f` (branch `webkitglib/2.52`), fetched by `build/webkit.sh` | LGPL-2 / LGPL-2.1 and BSD-style, per file (see the license files in the WebKit tree) |
| Our changes to WebKit | `patches/webkit/*.patch` in this repository (numbered, applied in order) | The license of each file a patch modifies; new files follow WebKit's own conventions |
| The embedder (C++ and the JavaScript glue) | `engine/` in this repository | Apache-2.0 |
| Libraries linked into the engine | Pinned by URL and SHA-256 in `build/pins.sh`, built by `build/deps/*.sh` | See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) |
| Emscripten runtime | Pinned in `build/pins.sh` (`EMSDK_VERSION`) | MIT and others, see THIRD_PARTY_NOTICES.md |

Everything the engine contains is rebuilt from these inputs. Nothing is added from
elsewhere. The host, the npm packages and the relay (`host/`, `packages/`) are separate
programs that talk to the engine over a message channel; they are not part of the
combined work.

## Your rights

You may use the engine, copy it, change it, rebuild it and distribute it, under the
licenses above. In particular you may modify WebKit or the embedder, build your own
engine and use it in place of ours, and reverse engineer the engine to debug your
modifications. The engine is loaded by URL (`engineUrl`, or `engineDir` in the Vite
plugin), and the host does not check a hash or a signature of it, so a rebuilt engine
works with a stock host. We keep it that way on purpose.

If you distribute engine files, you must in turn pass on the same rights: keep the
copyright and license notices, tell recipients that the engine includes LGPL code,
and provide (or offer) the corresponding source of your version, including your changes.

## Rebuild the engine

You need a Linux machine (or VM) with Docker, about 16 CPU cores and 32 GB of RAM or
more, and about 60 GB of free disk. A full build takes hours; later builds reuse the
compiler cache and finish much faster. Do not build on a laptop you need.

```bash
git clone https://github.com/yojona/InceptionJS.git
cd InceptionJS
docker build -t inceptionjs-build build

# The repository must be mounted at /work/inceptionjs: the compiler cache keys
# depend on that path.
docker run --rm -v "$PWD":/work/inceptionjs inceptionjs-build bash build/all.sh
```

`build/all.sh` runs, in order, and each step skips work already done:

1. `build/toolchain.sh`: installs the pinned Emscripten SDK.
2. `build/deps.sh`: downloads each dependency, checks its SHA-256 against
   `build/pins.sh`, and builds it into one wasm sysroot (zlib, libpng, libjpeg-turbo,
   libwebp, brotli, FreeType, ICU, HarfBuzz, libxml2, SQLite, OpenSSL, nghttp2,
   libpsl, curl, fontconfig).
3. `build/webkit.sh`: fetches WebKit at the pinned commit (sparse: `Source` and
   `Tools/Scripts`) and applies `patches/webkit/*.patch` in order.
4. `build/fs.sh`: stages the file system image (fonts, ICU data, fontconfig files,
   certificate bundle, WebKit resources) that becomes `inception-engine.data`. It
   reads fonts and the certificate bundle from the Debian image defined in
   `build/Dockerfile`.
5. `build/engine.sh`: configures and builds WebKit plus `engine/` into one module.

The output is `.work/out/engine/` with `inception-engine.js`, `.wasm` and `.data`.
`build/remote.sh` runs the same thing on a rented Hetzner Cloud server and always
deletes the server afterwards, if you prefer that.

## Modify WebKit or the embedder, and relink

- Change the embedder: edit files in `engine/`, then run `build/engine.sh` (inside the
  same container, with the same mount). Only the changed sources and the final link are
  redone.
- Change WebKit: add or edit a patch in `patches/webkit/` (they are numbered and
  applied in order), then run `build/engine.sh`. A changed series is re-applied to a
  clean checkout, then the build is incremental through the compiler cache. The link
  flags are in `engine/embedder.cmake` and `build/engine.sh`.
- Use the result: serve the three files from any directory and point `engineUrl` at
  `inception-engine.js`. For local testing, `ENGINE_DIR=.work/out/engine npm run serve`
  serves them to the example pages and the test suite.

Rebuilding from the repository and the pinned inputs gives you the same sources the
published engine files were built from. The WebAssembly output is not guaranteed to be
byte for byte identical (paths and timestamps), so expect the same inputs, not the same
hash.

## Getting the source

The corresponding source of the engine is: this repository at the tag of the release
whose engine you have, WebKit at the commit above, and the dependency archives listed
in `build/pins.sh` (by URL and SHA-256). If any of these becomes hard to find, open an
issue and we will provide the archives.
