// Assembles dist/: the browser host from the repository's host/ directory, plus
// this package's own modules (src/). The engine binaries are not part of the
// package; they are served separately (see the Vite plugin and the Next adapter).
import { cpSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = (path) => fileURLToPath(new URL(path, import.meta.url));

rmSync(here('dist'), { recursive: true, force: true });
cpSync(here('src'), here('dist'), { recursive: true });
cpSync(here('../../host'), here('dist/host'), { recursive: true });
console.log('inceptionjs: dist/ assembled');
