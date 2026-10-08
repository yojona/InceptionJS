// Assembles dist/: the browser host from the repository's host/ directory, plus
// this package's own modules (src/). The engine binaries are not part of the
// package; they are served separately (see the Vite plugin and the Next adapter).
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = (path) => fileURLToPath(new URL(path, import.meta.url));

rmSync(here('dist'), { recursive: true, force: true });
cpSync(here('src'), here('dist'), { recursive: true });
cpSync(here('../../host'), here('dist/host'), { recursive: true });
// The WebAssembly translator the host loads from next to itself
// (host/vendor/binaryen.js), so it resolves without a bundler.
mkdirSync(here('dist/host/vendor'), { recursive: true });
cpSync(createRequire(import.meta.url).resolve('binaryen'), here('dist/host/vendor/binaryen.js'));
console.log('inceptionjs: dist/ assembled');
