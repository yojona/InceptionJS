# Third-party notices

InceptionJS itself is Apache-2.0 (see [LICENSE](LICENSE) and [NOTICE](NOTICE)). This
file lists the software that is shipped in its npm packages or built into its engine
files, with the license it comes under. The license texts and copyright lines of the
engine's components also travel with the engine release (`licenses.txt`, generated
from the sources the build downloads). Where this list and a component's own license
files differ, the component's files are authoritative.

Licenses that require a notice are reproduced or referenced below. WebKit, which is
LGPL, is described in [LGPL.md](LGPL.md).

## npm packages

### `inceptionjs`

**binaryen 132.0.0**, Apache-2.0. Copyright 2026 The Binaryen Authors. Vendored into
`dist/host/vendor/binaryen.js` by `packages/inceptionjs/build.mjs`; the file keeps its
license header. The package has no NOTICE file. License text: the `LICENSE` file of the
binaryen package, which is the Apache License 2.0 text found in [LICENSE](LICENSE).

**ws 8.18.3**, MIT. Used by the relay.

```
Copyright (c) 2011 Einar Otto Stangvik <einaros@gmail.com>
Copyright (c) 2013 Arnout Kazemier and contributors
Copyright (c) 2016 Luigi Pinca and contributors

Permission is hereby granted, free of charge, to any person obtaining a copy of this
software and associated documentation files (the "Software"), to deal in the Software
without restriction, including without limitation the rights to use, copy, modify,
merge, publish, distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to the following
conditions:

The above copyright notice and this permission notice shall be included in all copies
or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED,
INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A
PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT
HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF
CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR
THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### `@inceptionjs/react`

Bundles nothing. Peer dependency: `react` (MIT), not included.

### Development only (not published)

`@playwright/test` (Apache-2.0), `vite`, `@vitejs/plugin-react`, `react`, `react-dom`
and `@types/*` (MIT), `typescript` (Apache-2.0). They are used by tests and the
example and are not part of any published package.

## Engine files (`inception-engine.js`, `.wasm`, `.data`)

### WebKit and what it bundles

Pinned commit `aec9d2ad958e716ab4bca4bf03007e6edac7323f` of
https://github.com/WebKit/WebKit (branch `webkitglib/2.52`).

| Component | License |
| --- | --- |
| WebCore | LGPL-2 and LGPL-2.1 (per file), Apple BSD-2-Clause style (per file); `LICENSE-LGPL-2`, `LICENSE-LGPL-2.1`, `LICENSE-APPLE` in `Source/WebCore` |
| JavaScriptCore | LGPL-2 (`COPYING.LIB`) and Apple BSD-style (per file) |
| WTF, bmalloc | BSD-2-Clause, with bundled files under the LLVM license (Apache-2.0 with LLVM exception), dragonbox (Apache-2.0 or Boost), libc++ headers and simde (MIT); texts in `Source/WTF` |
| Skia (`Source/ThirdParty/skia`) | BSD-3-Clause, with its own bundled third-party tree |

The engine is built with the JIT, WebAssembly, WebRTC and the PDF viewer off. Parts of
the WebKit source tree that are not compiled into the engine (ANGLE, libwebrtc, test
frameworks and similar) are not part of it. The per-file license scan of the files that
are linked is published with each engine release.

### Libraries built into the engine

Pinned by URL and SHA-256 in `build/pins.sh`, linked statically.

| Library | Version | License |
| --- | --- | --- |
| zlib | 1.3.1 | zlib |
| libpng | 1.6.43 | libpng |
| libjpeg-turbo | 3.0.4 | BSD-3-Clause, IJG, zlib |
| libwebp | 1.4.0 | BSD-3-Clause |
| brotli | 1.1.0 | MIT |
| FreeType | 2.13.3 | FreeType License (used under the FTL, not the GPL option) |
| ICU | 77.1 | Unicode License v3 |
| HarfBuzz | 9.0.0 | MIT |
| libxml2 | 2.12.9 | MIT |
| SQLite | 3.46.1 | Public domain |
| OpenSSL | 3.5.0 | Apache-2.0 |
| nghttp2 | 1.64.0 | MIT |
| libpsl | 0.21.5 | MIT; the built-in Public Suffix List data is MPL-2.0 (https://www.mozilla.org/MPL/2.0/) |
| curl | 8.17.0 | curl license |
| fontconfig | 2.15.0 | fontconfig license |

Portions of this software are copyright The FreeType Project (www.freetype.org). All
rights reserved.

### Emscripten output

The generated `inception-engine.js` and the module contain code from the Emscripten
toolchain (version pinned in `build/pins.sh`): the runtime and JavaScript library code
(MIT), musl libc (MIT), LLVM libc++, libc++abi, libunwind and compiler-rt (Apache-2.0
with LLVM exception), dlmalloc and emmalloc (public domain or MIT), and the WebGL
library code (MIT).

### Data in the file system image (`inception-engine.data`)

| Item | Origin | License |
| --- | --- | --- |
| fontconfig configuration | fontconfig install | fontconfig license |
| ICU data `icudt77l.dat` | ICU 77.1 | Unicode License v3 |
| DejaVu fonts | Debian `fonts-dejavu-core`, `fonts-dejavu-extra` | Bitstream Vera license with public-domain changes; the fonts may not be sold by themselves and modified versions may not use the "Bitstream Vera" or "DejaVu" names |
| Noto Color Emoji | Debian `fonts-noto-color-emoji` | SIL Open Font License 1.1 (check the package's `copyright` file for the version you build) |
| Noto Sans CJK Regular | Debian `fonts-noto-cjk` | SIL Open Font License 1.1 |
| Certificate bundle `cacert.pem` | Debian `ca-certificates` (Mozilla roots) | MPL-2.0 for the certificate data |
| WebKit built-in resources | WebKit checkout (`Source/WebCore/Resources`, `Composite.wav`) | per the WebKit files above |

The fonts and the certificate bundle are those of the Debian image used to build
(`build/Dockerfile`). The certificate bundle reflects the build date; it is not updated
after the engine is built.

## What is not included

No content decryption module, keys or codecs are in the engine: video and audio are
decoded by the host browser. The npm packages contain no engine files.
